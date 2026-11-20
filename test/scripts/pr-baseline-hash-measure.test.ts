// Opt-in production-shaped differential workload; regressions live in the owner suites.
// OPENCLAW_PR_HASH_MEASURE=/absolute/new-directory OPENCLAW_PR_HASH_BASE=<commit> \
//   node scripts/run-vitest.mjs test/scripts/pr-baseline-hash-measure.test.ts --testTimeout 900000
// Retains synthetic fixtures/results for cross-platform replay with measure.py.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createBaselineFixture } from "./pr-baseline-native.test-support.js";

const output = process.env.OPENCLAW_PR_HASH_MEASURE;
it.skipIf(!output || process.platform === "win32")(
  "validates retained evidence without temporary hash writes",
  () => {
    const root = resolve(output!);
    mkdirSync(root);
    const files = Number(process.env.OPENCLAW_PR_HASH_FILES ?? 62000);
    const logBytes = Number(process.env.OPENCLAW_PR_HASH_LOG_BYTES ?? 128 * 1024 * 1024);
    const bytes = Buffer.alloc(18000, 0xa5);
    const f = createBaselineFixture(root, 2, "IMPORTANT", (repo) => {
      for (let i = 0; i < files; i++) {
        const directory = join(repo, "payload", String(Math.floor(i / 100)));
        if (i % 100 === 0) {
          mkdirSync(directory, { recursive: true });
        }
        bytes.writeUInt32LE(i);
        writeFileSync(join(directory, `${i}.bin`), bytes);
      }
    });
    f.writeLocal("gates-build.log", Buffer.alloc(logBytes, 0x61));
    f.pass("prepare-baseline-refresh", f.manifest(f.advanceMain("synthetic baseline")));
    f.approve();
    f.publish();
    const main = f.advanceMain("successor baseline", [f.product[0]!]);
    f.pass("prepare-baseline-successor", f.successor(main));
    f.approve();
    const context = f.readLocal("prep-context.env").toString();
    const value = (name: string) => new RegExp(`^${name}=(.*)$`, "mu").exec(context)![1]!;
    const args = [
      "validate",
      "42",
      f.incoming,
      f.prepGit("rev-parse", "HEAD"),
      value("PREP_INCOMING_JSON_OID"),
      value("PREP_BASELINE_REFRESH_HEAD"),
      value("PREP_BASELINE_REFRESH_OID"),
    ];
    for (const arm of ["base", "candidate"]) {
      const source = join(root, arm);
      mkdirSync(source);
      for (const directory of ["pr-lib", "lib"]) {
        cpSync(join(process.cwd(), "scripts", directory), join(source, directory), {
          recursive: true,
        });
      }
      if (arm === "base") {
        writeFileSync(
          join(source, "pr-lib/baseline-refresh.mjs"),
          execFileSync("git", [
            "show",
            `${process.env.OPENCLAW_PR_HASH_BASE ?? "HEAD"}:scripts/pr-lib/baseline-refresh.mjs`,
          ]),
        );
      }
    }
    writeFileSync(
      join(root, "workload.json"),
      JSON.stringify({
        cwd: f.worktree,
        args,
        env: { ...f.env, OPENCLAW_PR_CAPTURED_MAIN: main },
        files,
        payloadBytes: files * bytes.length,
        logBytes,
      }),
    );
    writeFileSync(
      join(root, "probe.mjs"),
      `
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const start = performance.now(), cpu = process.cpuUsage();
const readIo = () => process.platform === 'linux' ? Object.fromEntries(
 fs.readFileSync('/proc/self/io','utf8').trim().split('\\n').map(l => {
  const [key,value] = l.split(':'); return [key,Number(value)];
 })) : null;
const before = readIo(), hashes = [];
let temporaryBytes = 0, temporaryFiles = 0, peakHeap = 0, peakExternal = 0, capturedReadBytes = 0;
const write = fs.writeFileSync, read = fs.readFileSync, run = cp.execFileSync;
fs.readFileSync = function(path,...rest) {
 const result = read.call(this,path,...rest);
 if (typeof path === 'number' && Buffer.isBuffer(result)) capturedReadBytes += result.length;
 return result;
};
fs.writeFileSync = function(path, bytes, ...rest) {
 if (String(path).includes('openclaw-pr-hash-')) {
  temporaryFiles++; temporaryBytes += Buffer.byteLength(bytes);
 }
 return write.call(this,path,bytes,...rest);
};
cp.execFileSync = function(file,args,options,...rest) {
 const hashing = args[0] === 'hash-object' && args.includes('--stdin');
 const size = hashing ? (options.input?.length ?? fs.fstatSync(options.stdio[0]).size) : 0;
 const result = run.call(this,file,args,options,...rest);
 if (hashing) {
  hashes.push({bytes:size,write:args.includes('-w'),oid:String(result).trim()});
  const memory = process.memoryUsage();
  peakHeap = Math.max(peakHeap,memory.heapUsed); peakExternal = Math.max(peakExternal,memory.external);
 }
 return result;
};
syncBuiltinESMExports();
process.on('exit', () => {
 const after = readIo();
 write(process.env.HASH_MEASURE_RESULT, JSON.stringify({milliseconds:performance.now()-start,
  cpu:process.cpuUsage(cpu),usage:process.resourceUsage(),peakHeap,peakExternal,
  io:before ? Object.fromEntries(Object.keys(before).map(k => [k,after[k]-before[k]])) : null,
  temporaryBytes,temporaryFiles,capturedReadBytes,hashes}));
});
`,
    );
    writeFileSync(
      join(root, "measure.py"),
      `#!/usr/bin/env python3
import json,os,pathlib,resource,subprocess,time
root=pathlib.Path(__file__).resolve().parent
work=json.loads((root/'workload.json').read_text())
env={**os.environ,**work['env']}
# Native platform tools, never the fixture's host PATH.
env['PATH']=os.environ['PATH']
results=[]
for i,arm in enumerate(['base','base','base']+['base','candidate']*5):
 result=root/('sample-%d.json'%i)
 before=resource.getrusage(resource.RUSAGE_CHILDREN)
 start=time.monotonic(); load=os.getloadavg()
 run=subprocess.run(['node','--import',str(root/'probe.mjs'),str(root/arm/'pr-lib/correction-review.mjs'),*work['args']],
  cwd=work['cwd'],env={**env,'HASH_MEASURE_RESULT':str(result)},capture_output=True,timeout=120)
 after=resource.getrusage(resource.RUSAGE_CHILDREN)
 sample=json.loads(result.read_text())
 sample.update(arm=arm,status=run.returncode,stdout=run.stdout.decode(),stderr=run.stderr.decode(),
  loadBefore=load,loadAfter=os.getloadavg(),wallSeconds=time.monotonic()-start,treeUserSeconds=after.ru_utime-before.ru_utime,
  treeSystemSeconds=after.ru_stime-before.ru_stime)
 results.append(sample)
 print(json.dumps({k:v for k,v in sample.items() if k not in ['hashes','stdout','stderr']}),flush=True)
 assert run.returncode == 0, run.stderr
 assert sample['hashes'] == results[0]['hashes']
 assert sample['stdout'] == results[0]['stdout']
 assert sample['temporaryBytes'] == (0 if arm=='candidate' else results[0]['temporaryBytes'])
(root/'results.json').write_text(json.dumps(results,indent=2))
assert results[0]['temporaryBytes'] >= work['logBytes']
`,
    );
    const result = spawnSync("python3", [join(root, "measure.py")], { encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    console.log(result.stdout);
  },
);
