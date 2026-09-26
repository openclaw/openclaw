import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { hasUnjoinedWork, runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import {
  createFixtureDiagnostics,
  type FixtureDiagnostics,
} from "../helpers/fixture-diagnostics.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { toolingMtsEntrypoints } from "./tooling-mts-runtime.test-support.mts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const artifactBytes = Buffer.from([0, 255, 128, 10, 65]);
type Receipt = {
  version: number;
  id: string;
  ownerPid: number;
  state: string;
  users: string;
  kind: string;
  durable: boolean;
  hold?: string;
};
type Stage = { root: string; source: string; receipt: Receipt; destination?: string };
type Recovery = { id: string; recovered: boolean; reason: string };
type Inspection = {
  entries: { id: string; status: string; reason: string }[];
  incomplete: boolean;
  nextCursor?: string;
  elapsedMs: number;
};

async function withFixture(scenario: (context: ReturnType<typeof createFixture>) => Promise<void>) {
  const diagnostics = createFixtureDiagnostics("staging-recovery");
  const f = createFixture(diagnostics);
  let failure: Error | undefined;
  try {
    await scenario(f);
  } catch (error) {
    failure =
      error instanceof Error ? error : new Error("Recovery scenario failed", { cause: error });
  }
  try {
    await f.close(Boolean(failure));
  } catch (error) {
    diagnostics?.report("failure");
    throw failure
      ? new AggregateError([failure, error], "Recovery assertion and fixture cleanup failed", {
          cause: error,
        })
      : error;
  }
  if (failure) {
    throw failure;
  }
}

function createFixture(diagnostics?: FixtureDiagnostics) {
  const nodeExecutable = resolveTestNodeExecPath();
  const nodeArgs = resolveVitestNodeArgs();
  // openclaw-temp-dir: allow retain input ownership when a child cannot be joined
  const root = mkdtempSync(join(tmpdir(), "openclaw-crabbox-recovery-"));
  const source = join(root, "source"),
    staging = join(root, "staging"),
    bin = join(root, "bin"),
    home = join(root, "home");
  const cli = join(bin, "crabbox"),
    plan = join(root, "inventory.json"),
    calls = join(root, "native-calls.jsonl"),
    nodePolicy = join(root, "node-policy.jsonl"),
    state = join(root, "state");
  for (const path of [source, staging, bin, home, join(state, "crabbox", "claims")]) {
    mkdirSync(path, { recursive: true });
  }
  const env: NodeJS.ProcessEnv = {
    ...createNestedGitEnv(),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: state,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    PATH: bin + delimiter + process.env.PATH,
    OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY: "1",
    OPENCLAW_CRABBOX_SYNC_TMPDIR: staging,
  };
  delete env.GIT_CONFIG_PARAMETERS;
  const gitAt = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const initialize = (directory: string) => {
    gitAt(directory, "init", "--quiet", "--initial-branch=main", "--template=");
    gitAt(directory, "remote", "add", "origin", "https://example.invalid/fixture.git");
  };
  initialize(source);
  writeFileSync(join(source, "source.txt"), "retained source\n");
  const commit = (cwd = source) => {
    gitAt(cwd, "add", "-A");
    gitAt(cwd, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  };
  commit();
  const inventory = (
    claims: { leaseId: string; repoRoot: string }[] = [],
    gate?: { ready: string; release: string },
  ) => writeFileSync(plan, JSON.stringify({ claims, gate }));
  inventory();
  writeFileSync(calls, "");
  writeFileSync(nodePolicy, "");
  writeFileSync(
    cli,
    `#!/usr/bin/env -S ${JSON.stringify(nodeExecutable)} ${nodeArgs.join(" ")}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(nodePolicy)}, JSON.stringify({entry:'claims-cli', nodeArgs:process.execArgv.filter(flag=>${JSON.stringify(nodeArgs)}.includes(flag))}) + '\\n');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (JSON.stringify(args) !== JSON.stringify(['claims','list','--json'])) process.exit(91);
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, 'utf8'));
const finish = () => process.stdout.write(JSON.stringify({version:1,source:'local-claims',claims:plan.claims,problems:[]}));
if (plan.gate) {
  fs.writeFileSync(plan.gate.ready, 'ready');
  const timer = setInterval(() => { if (fs.existsSync(plan.gate.release)) { clearInterval(timer); finish(); } }, 10);
} else finish();
`,
  );
  chmodSync(cli, 0o700);
  const controllers = new Set<AbortController>(),
    pending = new Set<Promise<unknown>>();
  let unjoined = false;
  const command = (
    binary: string,
    args: string[],
    override: NodeJS.ProcessEnv = {},
    timeoutMs = 30_000,
    role = "command",
  ) => {
    const observation = diagnostics?.command(role);
    const controller = new AbortController();
    controllers.add(controller);
    const task = (async () => {
      let stdout = "",
        stderr = "",
        signal: NodeJS.Signals | null = null,
        tooLarge = false;
      let failure: unknown;
      try {
        const status = await runManagedCommand({
          bin: binary,
          args,
          cwd: repository,
          env: { ...env, ...override },
          stdio: ["ignore", "pipe", "pipe"],
          timeoutMs,
          requireProcessTreeExit: true,
          signal: controller.signal,
          onReady(child) {
            const capture = (chunk: Buffer, output: "stdout" | "stderr") => {
              observation?.output(output, chunk.byteLength);
              if (tooLarge) {
                return;
              }
              if (stdout.length + stderr.length + chunk.length > 1024 * 1024) {
                tooLarge = true;
                controller.abort(new Error("Recovery fixture output exceeded its limit"));
              } else if (output === "stdout") {
                stdout += chunk.toString();
              } else {
                stderr += chunk.toString();
              }
            };
            child.stdout!.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
            child.stderr!.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
            child.once("exit", (_code, received) => {
              signal = received;
            });
            observation?.ready(child);
          },
        });
        expect(tooLarge).toBe(false);
        return { status, signal, stdout, stderr };
      } catch (error) {
        failure = error;
        unjoined ||= hasUnjoinedWork(error);
        throw error;
      } finally {
        observation?.settled(failure);
        controllers.delete(controller);
      }
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  const program = (
    body: string,
    prelude = "",
    timeoutMs = 30_000,
    role = "program",
    includeCapsule = false,
  ) =>
    command(
      nodeExecutable,
      [
        ...nodeArgs,
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(toolingMtsEntrypoints.crabboxSourceCapsule),
          nodeExecutable,
        ).slice(0, -1),
        "--input-type=module",
        "-e",
        `import fs from 'node:fs';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import {join,resolve,basename} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const ctx = ${JSON.stringify({ root, repository: source, staging, cli, calls })};
${prelude}
syncBuiltinESMExports();
${includeCapsule ? `const {prepareCrabboxSourceCapsule} = await import(${JSON.stringify(resolveRuntimeWorkerUrl(toolingMtsEntrypoints.crabboxSourceCapsule).href)});` : ""}
const {createStaging,createMirrorStaging,discoverStaging,recoverDiscoveredStaging,runStagingCommand} = await import(${JSON.stringify(resolveRuntimeWorkerUrl(toolingMtsEntrypoints.crabboxStaging).href)});
const {captureClaimNamespace} = await import(${JSON.stringify(resolveRuntimeWorkerUrl(toolingMtsEntrypoints.crabboxStagingClaims).href)});
const {preserveCrabboxArtifacts} = await import(${JSON.stringify(resolveRuntimeWorkerUrl(toolingMtsEntrypoints.crabboxStagingArtifacts).href)});
${body}`,
      ],
      {},
      timeoutMs,
      role,
    );
  const prepare = async (
    after = "",
    options: { paths?: string[]; before?: string; prelude?: string; localGitSeed?: boolean } = {},
  ) => {
    const names = options.paths ?? ["source.txt"];
    const selection = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(nodePolicy)},JSON.stringify({entry:'source-selection',nodeArgs:process.execArgv.filter(flag=>${JSON.stringify(nodeArgs)}.includes(flag))})+'\\n');const paths=${JSON.stringify(names)}.filter(path=>fs.lstatSync(path,{throwIfNoEntry:false}));process.stdout.write(JSON.stringify({candidate:{files:paths.length},topFiles:paths.map(path=>({path})),localGitSeed:${options.localGitSeed ? "{source:'local'}" : "undefined"}}));`;
    const result = await program(
      `
${options.before ?? ""}
const cap = prepareCrabboxSourceCapsule({repoRoot:ctx.repository,syncRoot:ctx.staging,base:'HEAD',syncPlan:{command:process.execPath,args:${JSON.stringify([...nodeArgs, "-e", selection])}}});
let artifacts;
${after}
const receipt = JSON.parse(fs.readFileSync(join(cap.staging.root,'staging.json'),'utf8'));
fs.writeSync(1,JSON.stringify({nodeArgs:process.execArgv.slice(0,process.execArgv.indexOf('-e')),root:cap.staging.root,source:cap.directory,receipt,destination:artifacts?.kind==='copied'?artifacts.destination.path:undefined}));
process.kill(process.pid,'SIGKILL');`,
      options.prelude,
      options.before ? 120_000 : 30_000,
      "prepare",
      true,
    );
    expect(result.signal, result.stderr).toBe("SIGKILL");
    const { nodeArgs: producerNodeArgs, ...stage } = JSON.parse(result.stdout) as Stage & {
      nodeArgs: string[];
    };
    expect(producerNodeArgs, "fixture producer inherits the Node shutdown policy").toContain(
      "--no-concurrent-sparkplug",
    );
    return stage;
  };
  const wrapper = (args: string[], override: NodeJS.ProcessEnv = {}) =>
    command(
      nodeExecutable,
      [...nodeArgs, resolve(repository, "scripts/crabbox-wrapper.mjs"), "staging", ...args],
      override,
      undefined,
      "wrapper",
    );
  const recover = async (stage: Stage, args: string[] = [], override: NodeJS.ProcessEnv = {}) => {
    const result = await wrapper(["recover", stage.receipt.id, ...args], override);
    const report = JSON.parse(result.stdout) as Recovery;
    expect(result.status, result.stdout + result.stderr).toBe(report.recovered ? 0 : 1);
    return { ...result, report };
  };
  const automatic = async () => {
    const result = await program(
      `const discovery=discoverStaging(ctx.staging);const result=await recoverDiscoveredStaging(ctx.staging,discovery,{binary:ctx.cli,cwd:ctx.repository});console.log(JSON.stringify({discovery,result}));`,
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as { discovery: Inspection; result?: Recovery };
  };
  const waitFor = async (path: string) => {
    const deadline = Date.now() + 10_000;
    while (!existsSync(path) && Date.now() < deadline) {
      await delay(10);
    }
    expect(existsSync(path), "fixture never reached its synchronization point: " + path).toBe(true);
  };
  return {
    root,
    source,
    staging,
    env,
    cli,
    calls,
    nodePolicies: () =>
      readFileSync(nodePolicy, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { entry: string; nodeArgs: string[] }),
    command,
    program,
    prepare,
    wrapper,
    recover,
    automatic,
    inventory,
    initialize,
    commit,
    git: (...args: string[]) => gitAt(source, ...args),
    gitAt,
    waitFor,
    stage: (value: string) => diagnostics?.stage(value),
    receipt: (stage: Stage) =>
      JSON.parse(readFileSync(join(stage.root, "staging.json"), "utf8")) as Receipt,
    async close(failed = false) {
      for (const controller of controllers) {
        controller.abort();
      }
      if (failed) {
        diagnostics?.report("failure");
      }
      await Promise.allSettled(pending);
      if (unjoined) {
        console.error("Recovery fixture retained after unverified child cleanup: " + root);
        throw Object.assign(new Error("Recovery fixture still has unjoined work"), {
          processTreeState: "indeterminate",
        });
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const admit = "cap.staging.admitted(captureClaimNamespace(cap.directory), ['cbx_fixture']);";
const diagnostics =
  "fs.mkdirSync(join(cap.directory,'.crabbox','runs','lease'),{recursive:true});fs.writeFileSync(join(cap.directory,'.crabbox','runs','lease','output.bin'),Buffer.from([0,255,128,10,65]));";
const preserve =
  "artifacts=preserveCrabboxArtifacts(cap.directory,ctx.repository);cap.staging.preserved(artifacts);";
function interruptedRemoval(remove: "none" | "file" | "payload") {
  return `const originalRm=fs.rmSync;let interrupted=false;
fs.rmSync=(path,options)=>{if(path===cap.staging.payload){interrupted=true;${remove === "file" ? "originalRm(join(cap.directory,'source.txt'));" : remove === "payload" ? "originalRm(path,options);" : ""}throw new Error('fixture interrupted removal');}return originalRm(path,options);};
syncBuiltinESMExports();try{cap.staging.dispose();}catch(error){if(!interrupted)throw error;}finally{fs.rmSync=originalRm;syncBuiltinESMExports();}
if(!interrupted)throw new Error('fixture failed to interrupt disposal');`;
}

const seedMirror = `
function seed(owner) {
  if (!owner) throw new Error('mirror allocation failed');
  const source=join(owner.staging.payload,'source');fs.mkdirSync(source);
  const bytes=Buffer.from('uncommitted mirror source\\n');fs.writeFileSync(join(source,'source.txt'),bytes);
  fs.writeFileSync(join(owner.staging.root,'mirror.sqlite'),'closed fixture cache');
  const blob=crypto.createHash('sha1').update('blob '+bytes.length+'\\0').update(bytes).digest('hex');
  owner.staging.prepared({files:[{path:'source.txt',mode:'100644',blob}],deleted:[]});
  return source;
}`;

function holdDatabase(path: string) {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE");
  let released = false;
  return () => {
    if (!released) {
      database.exec("ROLLBACK");
      database.close();
      released = true;
    }
  };
}

async function idleMirrors(
  f: ReturnType<typeof createFixture>,
  repositories: string[],
  fillCapacity = false,
) {
  const result = await f.program(`${seedMirror}
const stages=${JSON.stringify(repositories)}.map(repository=>{
  const owner=createMirrorStaging(ctx.staging,repository);const source=seed(owner);owner.finish();
  return {root:owner.staging.root,source,receipt:JSON.parse(fs.readFileSync(join(owner.staging.root,'staging.json'),'utf8'))};
});
if(${fillCapacity})for(let i=stages.length;i<32;i++)fs.mkdirSync(join(ctx.staging,'mirrors',String(i).padStart(64,'0')),{mode:0o700});
console.log(JSON.stringify(stages));`);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Stage[];
}

function blockingMirrorIo(root: string, hook: string) {
  return `const {DatabaseSync}=await import('node:sqlite');
function blockedIo(){
  const gate=new DatabaseSync(${JSON.stringify(join(root, "io-gate.sqlite"))},{timeout:15000});
  fs.writeFileSync(${JSON.stringify(join(root, "io-ready"))},'ready');
  try{gate.exec('BEGIN EXCLUSIVE');gate.exec('ROLLBACK');}finally{gate.close();}
}
${hook}`;
}

describe.skipIf(process.platform === "win32")("Crabbox reusable staging ownership", () => {
  it("waits for allocation contention and reuses the other repository's warm mirror", async () =>
    withFixture(async (f) => {
      const other = join(f.root, "other-repository");
      mkdirSync(other);
      f.initialize(other);
      const [, warm] = await idleMirrors(f, [f.source, other]);
      const unlock = holdDatabase(join(f.staging, "mirrors", ".allocation.lock"));
      const ready = join(f.root, "allocation-waiting");
      try {
        const pending = f.program(
          `const next=createMirrorStaging(ctx.staging,${JSON.stringify(other)});
console.log(JSON.stringify({reused:next?.reused,root:next?.staging.root}));next?.discard();`,
          `const error=console.error;console.error=(...args)=>{error(...args);if(args.join(' ').includes('waiting for source mirror allocation'))fs.writeFileSync(${JSON.stringify(ready)},'waiting');};`,
        );
        await f.waitFor(ready);
        unlock();
        const result = await pending;
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ reused: true, root: warm!.root });
        expect(result.stderr.match(/waiting for source mirror allocation/g)).toHaveLength(1);
        expect(result.stderr).not.toContain("using a fresh capsule");
      } finally {
        unlock();
      }
    }));

  it("falls back to a fresh capsule only after the bounded allocation wait expires", async () =>
    withFixture(async (f) => {
      const [warm] = await idleMirrors(f, [f.source]);
      const unlock = holdDatabase(join(f.staging, "mirrors", ".allocation.lock"));
      try {
        const result = await f.program(
          `const cap=prepareCrabboxSourceCapsule({repoRoot:ctx.repository,syncRoot:ctx.staging,base:'HEAD',reuseMirror:true,syncPlan:{command:process.execPath,args:['-e','process.stdout.write(JSON.stringify({candidate:{files:1},topFiles:[{path:"source.txt"}]}))']}});
const receipt=JSON.parse(fs.readFileSync(join(cap.staging.root,'staging.json'),'utf8'));
console.log(JSON.stringify({budgets,root:cap.staging.root,mirror:Boolean(receipt.mirror),source:fs.readFileSync(join(cap.directory,'source.txt'),'utf8')}));cap.cleanup();`,
          `const {DatabaseSync}=await import('node:sqlite');const execute=DatabaseSync.prototype.exec;const budgets=[];
DatabaseSync.prototype.exec=function(sql){const match=/busy_timeout\\s*=\\s*(\\d+)/u.exec(sql);if(match&&Number(match[1])>0){budgets.push(Number(match[1]));sql=sql.replace(match[0],'busy_timeout=1');}return execute.call(this,sql);};`,
          30_000,
          "capsule",
          true,
        );
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          budgets: [120_000],
          mirror: false,
          source: "retained source\n",
        });
        expect(JSON.parse(result.stdout).root).not.toBe(warm!.root);
        expect(result.stderr.match(/waiting for source mirror allocation/g)).toHaveLength(1);
        expect(result.stderr).toContain(
          "[crabbox] source mirror allocation is busy; using a fresh capsule",
        );
        expect(existsSync(warm!.root)).toBe(true);
      } finally {
        unlock();
      }
    }));

  it("shares the allocation wait budget when a contender wins between SQLite statements", async () =>
    withFixture(async (f) => {
      const [warm] = await idleMirrors(f, [f.source]);
      const result = await f.program(
        `try{const next=createMirrorStaging(ctx.staging,ctx.repository);console.log(JSON.stringify({allocated:Boolean(next),budgets,journalRetried}));next?.discard();}finally{execute.call(holder,'ROLLBACK');holder.close();}`,
        `const {DatabaseSync}=await import('node:sqlite');const execute=DatabaseSync.prototype.exec;
const holder=new DatabaseSync(join(ctx.staging,'mirrors','.allocation.lock'),{timeout:0});
execute.call(holder,'PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE');
const budgets=[];let journalRetried=false;
DatabaseSync.prototype.exec=function(sql){
  const match=/busy_timeout\\s*=\\s*(\\d+)/u.exec(sql);
  if(match){budgets.push(Number(match[1]));sql=sql.replace(match[0],'busy_timeout=1');}
  if(sql==='PRAGMA journal_mode=MEMORY'){
    execute.call(holder,'ROLLBACK');
    const result=execute.call(this,sql);journalRetried=true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
    execute.call(holder,'BEGIN EXCLUSIVE');
    return result;
  }
  return execute.call(this,sql);
};`,
      );
      expect(result.status, result.stderr).toBe(0);
      const outcome = JSON.parse(result.stdout) as {
        allocated: boolean;
        budgets: number[];
        journalRetried: boolean;
      };
      expect(outcome).toMatchObject({ allocated: false, journalRetried: true });
      expect(outcome.budgets).toHaveLength(2);
      expect(outcome.budgets[0]).toBe(120_000);
      expect(outcome.budgets[1]).toBeGreaterThan(0);
      expect(outcome.budgets[1]).toBeLessThan(outcome.budgets[0]!);
      expect(result.stderr.match(/waiting for source mirror allocation/g)).toHaveLength(1);
      expect(result.stderr).toContain(
        "[crabbox] source mirror allocation is busy; using a fresh capsule",
      );
      expect(existsSync(warm!.root)).toBe(true);
    }));

  it("keeps other warm mirrors available while a slot's database digest is slow", async () =>
    withFixture(async (f) => {
      const other = join(f.root, "other-repository");
      mkdirSync(other);
      f.initialize(other);
      const [slow, warm] = await idleMirrors(f, [f.source, other]);
      const unlock = holdDatabase(join(f.root, "io-gate.sqlite"));
      try {
        const pending = f.program(
          "const next=createMirrorStaging(ctx.staging,ctx.repository);console.log(JSON.stringify({reused:next?.reused,root:next?.staging.root}));next?.discard();",
          blockingMirrorIo(
            f.root,
            `const open=fs.openSync,read=fs.readSync;let databaseFd;
fs.openSync=(path,...args)=>{const fd=open(path,...args);if(path===${JSON.stringify(join(slow!.root, "mirror.sqlite"))})databaseFd=fd;return fd;};
fs.readSync=(fd,...args)=>{if(fd===databaseFd){databaseFd=undefined;blockedIo();}return read(fd,...args);};`,
          ),
        );
        await f.waitFor(join(f.root, "io-ready"));
        const concurrent = await f.program(
          `const next=createMirrorStaging(ctx.staging,${JSON.stringify(other)});console.log(JSON.stringify({reused:next?.reused,root:next?.staging.root}));next?.discard();`,
        );
        expect(concurrent.status, concurrent.stderr).toBe(0);
        expect(JSON.parse(concurrent.stdout)).toEqual({ reused: true, root: warm!.root });
        expect(concurrent.stderr).not.toContain("waiting for source mirror allocation");
        unlock();
        const result = await pending;
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ reused: true, root: slow!.root });
      } finally {
        unlock();
      }
    }));

  it("reserves an eviction victim until disposal finishes without blocking another warm slot", async () =>
    withFixture(async (f) => {
      const other = join(f.root, "other-repository");
      const newcomer = join(f.root, "new-repository");
      for (const sourceRepository of [other, newcomer]) {
        mkdirSync(sourceRepository);
        f.initialize(sourceRepository);
      }
      const [victim, warm] = await idleMirrors(f, [f.source, other], true);
      const unlock = holdDatabase(join(f.root, "io-gate.sqlite"));
      try {
        const pending = f.program(
          `const next=createMirrorStaging(ctx.staging,${JSON.stringify(newcomer)});console.log(JSON.stringify({allocated:Boolean(next),reused:next?.reused}));next?.discard();`,
          blockingMirrorIo(
            f.root,
            `const remove=fs.rmSync;fs.rmSync=(path,...args)=>{if(path===${JSON.stringify(join(victim!.root, "payload"))})blockedIo();return remove(path,...args);};`,
          ),
        );
        await f.waitFor(join(f.root, "io-ready"));
        const concurrent = await f.program(
          `const victim=createMirrorStaging(ctx.staging,ctx.repository);const next=createMirrorStaging(ctx.staging,${JSON.stringify(other)});
console.log(JSON.stringify({victimAdopted:Boolean(victim),reused:next?.reused,root:next?.staging.root}));victim?.discard();next?.discard();`,
        );
        expect(concurrent.status, concurrent.stderr).toBe(0);
        expect(JSON.parse(concurrent.stdout)).toEqual({
          victimAdopted: false,
          reused: true,
          root: warm!.root,
        });
        expect(concurrent.stderr).not.toContain("waiting for source mirror allocation");
        expect(existsSync(victim!.root)).toBe(true);
        unlock();
        const result = await pending;
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ allocated: true, reused: false });
        expect(existsSync(victim!.root)).toBe(false);
        expect(
          readdirSync(join(f.staging, "mirrors")).filter((name) => name !== ".allocation.lock"),
        ).toHaveLength(32);
      } finally {
        unlock();
      }
    }));

  it("records interrupted eviction for recovery and rejects changed disposal metadata", async () =>
    withFixture(async (f) => {
      const newcomer = join(f.root, "new-repository");
      mkdirSync(newcomer);
      f.initialize(newcomer);
      const [victim] = await idleMirrors(f, [f.source], true);
      const interrupted = await f.program(
        `createMirrorStaging(ctx.staging,${JSON.stringify(newcomer)});throw new Error('eviction did not reach disposal');`,
        `const remove=fs.rmSync;fs.rmSync=(path,...args)=>{if(path===${JSON.stringify(join(victim!.root, "payload"))}){remove(${JSON.stringify(join(victim!.source, "source.txt"))});process.kill(process.pid,'SIGKILL');}return remove(path,...args);};`,
      );
      expect(interrupted.signal, interrupted.stderr).toBe("SIGKILL");
      expect(f.receipt(victim!)).toMatchObject({ mirror: { idle: true, disposing: true } });
      const unexpected = join(victim!.root, "unrecorded-disposal-data");
      writeFileSync(unexpected, "preserve unknown bytes");
      expect((await f.recover(victim!)).report.recovered).toBe(false);
      expect(readFileSync(unexpected, "utf8")).toBe("preserve unknown bytes");
      rmSync(unexpected);
      const recovered = await f.program(
        `process.exitCode=await runStagingCommand(['recover',${JSON.stringify(victim!.receipt.id)}],ctx.staging,{binary:ctx.cli,cwd:ctx.repository});if(receiptWrites!==0)throw new Error('resuming durable disposal rewrote its receipt');`,
        `const open=fs.openSync,close=fs.closeSync,flush=fs.fsyncSync;const receiptDescriptors=new Set();let receiptWrites=0;
fs.openSync=(path,...args)=>{const fd=open(path,...args);if(typeof path==='string'&&basename(path).startsWith('.staging.json.')){receiptWrites++;receiptDescriptors.add(fd);}return fd;};
fs.closeSync=(fd)=>{receiptDescriptors.delete(fd);return close(fd);};
fs.fsyncSync=(fd)=>{if(receiptDescriptors.has(fd))throw Object.assign(new Error('fixture receipt flush unavailable'),{code:'EINVAL'});return flush(fd);};`,
      );
      expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
      expect((JSON.parse(recovered.stdout) as Recovery).recovered).toBe(true);
      expect(existsSync(victim!.root)).toBe(false);
      expect(
        readdirSync(join(f.staging, "mirrors")).filter((name) => name !== ".allocation.lock"),
      ).toHaveLength(31);
    }));

  it.each(["receipt", "root", "stage", "lock", "slot"] as const)(
    "recovers disposal interrupted after removing the %s while protecting replacements",
    async (phase) =>
      withFixture(async (f) => {
        // Keep both directories live initially so a replacement cannot reuse the original inode.
        const replacement = join(f.root, "replacement-directory");
        mkdirSync(replacement, { mode: 0o700 });
        writeFileSync(join(replacement, "sentinel"), "preserve replacement bytes");
        const [victim] = await idleMirrors(f, [f.source]);
        const key = readdirSync(join(f.staging, "mirrors")).find(
          (name) => name !== ".allocation.lock",
        )!;
        const slot = join(f.staging, "mirrors", key);
        const tombstone = join(
          f.staging,
          basename(victim!.root).replace(victim!.receipt.id, "disposal-" + victim!.receipt.id),
        );
        const target = {
          receipt: join(victim!.root, "staging.json"),
          root: victim!.root,
          stage: join(slot, "stage"),
          lock: join(slot, "lock"),
          slot,
        }[phase];
        const args = ["recover", victim!.receipt.id];
        const invoke = (command: string[]) =>
          f.program(
            `process.exitCode=await runStagingCommand(${JSON.stringify(command)},ctx.staging,{binary:ctx.cli,cwd:ctx.repository});`,
          );
        const interrupted = await f.program(
          `process.exitCode=await runStagingCommand(${JSON.stringify(args)},ctx.staging,{binary:ctx.cli,cwd:ctx.repository});`,
          `for(const method of ['rmSync','rmdirSync','unlinkSync']){const original=fs[method];fs[method]=(path,...args)=>{const result=original(path,...args);if(path===${JSON.stringify(target)})process.kill(process.pid,'SIGKILL');return result;};}`,
        );
        expect(interrupted.signal, interrupted.stderr).toBe("SIGKILL");
        expect(existsSync(tombstone)).toBe(true);
        const inspection = await invoke(["inspect"]);
        expect(inspection.status, inspection.stderr).toBe(0);
        expect((JSON.parse(inspection.stdout) as Inspection).entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: victim!.receipt.id, status: "candidate" }),
          ]),
        );

        const replaced = phase === "receipt" || phase === "root" ? victim!.root : slot;
        const retained = join(f.root, "retained-directory");
        const hadOriginal = existsSync(replaced);
        if (hadOriginal) {
          renameSync(replaced, retained);
        }
        renameSync(replacement, replaced);
        const refused = await invoke(args);
        expect(refused.status, refused.stdout + refused.stderr).toBe(1);
        expect((JSON.parse(refused.stdout) as Recovery).recovered).toBe(false);
        expect(readFileSync(join(replaced, "sentinel"), "utf8")).toBe("preserve replacement bytes");
        expect(existsSync(tombstone)).toBe(true);
        rmSync(replaced, { recursive: true });
        if (hadOriginal) {
          renameSync(retained, replaced);
        }

        const successor = phase === "slot" ? (await idleMirrors(f, [f.source]))[0] : undefined;
        const recovered = await invoke(args);
        expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
        expect((JSON.parse(recovered.stdout) as Recovery).recovered).toBe(true);
        expect(existsSync(victim!.root)).toBe(false);
        expect(existsSync(slot)).toBe(Boolean(successor));
        expect(existsSync(tombstone)).toBe(false);
        if (successor) {
          expect(f.receipt(successor)).toEqual(successor.receipt);
          expect(readFileSync(join(successor.source, "source.txt"), "utf8")).toBe(
            "uncommitted mirror source\n",
          );
        }
      }),
  );

  it.each(["before-stage", "stage", "lock", "slot"] as const)(
    "recovers receipt-less disposal interrupted at %s without adopting replacements",
    async (phase) =>
      withFixture(async (f) => {
        const newcomer = join(f.root, "new-repository");
        mkdirSync(newcomer);
        f.initialize(newcomer);
        const unexpectedRoot = join(f.root, "unexpected-root");
        const unexpectedSlot = join(f.root, "unexpected-slot");
        for (const directory of [unexpectedRoot, unexpectedSlot]) {
          mkdirSync(directory, { mode: 0o700 });
          writeFileSync(join(directory, "sentinel"), "preserve replacement bytes");
        }
        const discarded = await f.program(`${seedMirror}
const owner=createMirrorStaging(ctx.staging,ctx.repository);const source=seed(owner);
const stage={root:owner.staging.root,source,receipt:JSON.parse(fs.readFileSync(join(owner.staging.root,'staging.json'),'utf8'))};
owner.discard();
for(let i=1;i<32;i++)fs.mkdirSync(join(ctx.staging,'mirrors',String(i).padStart(64,'0')),{mode:0o700});
console.log(JSON.stringify(stage));`);
        expect(discarded.status, discarded.stderr).toBe(0);
        const victim = JSON.parse(discarded.stdout) as Stage;
        expect(existsSync(victim.root)).toBe(false);
        const key = readdirSync(join(f.staging, "mirrors")).find((name) =>
          existsSync(join(f.staging, "mirrors", name, "stage")),
        )!;
        const slot = join(f.staging, "mirrors", key);
        const tombstone = join(
          f.staging,
          basename(victim.root).replace(victim.receipt.id, "disposal-" + victim.receipt.id),
        );
        const target = {
          "before-stage": join(slot, "stage"),
          stage: join(slot, "stage"),
          lock: join(slot, "lock"),
          slot,
        }[phase];
        const interrupted = await f.program(
          `createMirrorStaging(ctx.staging,${JSON.stringify(newcomer)});throw new Error('empty-slot eviction did not reach teardown');`,
          `for(const method of ['rmSync','rmdirSync','unlinkSync']){const original=fs[method];fs[method]=(path,...args)=>{if(${JSON.stringify(phase)}==='before-stage'&&path===${JSON.stringify(target)})process.kill(process.pid,'SIGKILL');const result=original(path,...args);if(path===${JSON.stringify(target)})process.kill(process.pid,'SIGKILL');return result;};}`,
        );
        expect(interrupted.signal, interrupted.stderr).toBe("SIGKILL");
        expect(existsSync(tombstone)).toBe(true);
        const args = ["recover", victim.receipt.id];
        const invoke = (command: string[]) =>
          f.program(
            `process.exitCode=await runStagingCommand(${JSON.stringify(command)},ctx.staging,{binary:ctx.cli,cwd:ctx.repository});`,
          );
        const inspection = await invoke(["inspect"]);
        expect(inspection.status, inspection.stderr).toBe(0);
        expect((JSON.parse(inspection.stdout) as Inspection).entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: victim.receipt.id, status: "candidate" }),
          ]),
        );

        if (phase !== "slot") {
          const adoption = await f.program(
            "const owner=createMirrorStaging(ctx.staging,ctx.repository);console.log(JSON.stringify({adopted:Boolean(owner)}));owner?.discard();",
          );
          expect(adoption.status, adoption.stdout + adoption.stderr).toBe(0);
          expect(JSON.parse(adoption.stdout)).toEqual({ adopted: false });
          expect(existsSync(victim.root)).toBe(false);
        }

        renameSync(unexpectedRoot, victim.root);
        const refusedRoot = await invoke(args);
        expect(refusedRoot.status, refusedRoot.stdout + refusedRoot.stderr).toBe(1);
        expect((JSON.parse(refusedRoot.stdout) as Recovery).recovered).toBe(false);
        expect(readFileSync(join(victim.root, "sentinel"), "utf8")).toBe(
          "preserve replacement bytes",
        );
        expect(existsSync(tombstone)).toBe(true);
        renameSync(victim.root, unexpectedRoot);

        const retainedSlot = join(f.root, "retained-slot");
        const hadSlot = existsSync(slot);
        if (hadSlot) {
          renameSync(slot, retainedSlot);
        }
        renameSync(unexpectedSlot, slot);
        const refusedSlot = await invoke(args);
        expect(refusedSlot.status, refusedSlot.stdout + refusedSlot.stderr).toBe(1);
        expect((JSON.parse(refusedSlot.stdout) as Recovery).recovered).toBe(false);
        expect(readFileSync(join(slot, "sentinel"), "utf8")).toBe("preserve replacement bytes");
        expect(existsSync(tombstone)).toBe(true);
        renameSync(slot, unexpectedSlot);
        if (hadSlot) {
          renameSync(retainedSlot, slot);
        }

        const successor = phase === "slot" ? (await idleMirrors(f, [f.source]))[0] : undefined;
        const recovered = await invoke(args);
        expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
        expect((JSON.parse(recovered.stdout) as Recovery).recovered).toBe(true);
        expect(existsSync(victim.root)).toBe(false);
        expect(existsSync(slot)).toBe(Boolean(successor));
        expect(existsSync(tombstone)).toBe(false);
        if (successor) {
          expect(f.receipt(successor)).toEqual(successor.receipt);
          expect(readFileSync(join(successor.source, "source.txt"), "utf8")).toBe(
            "uncommitted mirror source\n",
          );
        }
      }),
  );

  it("seals and reuses a large cache database with bounded read buffers", async () =>
    withFixture(async (f) => {
      const result = await f.program(`${seedMirror}
const {DatabaseSync}=await import('node:sqlite');
const owner=createMirrorStaging(ctx.staging,ctx.repository);seed(owner);
const path=join(owner.staging.root,'mirror.sqlite');fs.rmSync(path);
const database=new DatabaseSync(path);
database.exec('CREATE TABLE payload (bytes BLOB); INSERT INTO payload VALUES (zeroblob(65 * 1024 * 1024))');
database.close();
const bytes=fs.statSync(path).size;
const allocate=Buffer.alloc;
Buffer.alloc=(size,...args)=>{if(size>128*1024)throw new Error('unbounded cache allocation');return allocate(size,...args);};
try {
  owner.finish();
  const next=createMirrorStaging(ctx.staging,ctx.repository);
  if(!next?.reused||next.staging.root!==owner.staging.root)throw new Error('large cache was not reused');
  next.discard();
} finally { Buffer.alloc=allocate; }
console.log(JSON.stringify({bytes}));`);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).bytes).toBeGreaterThan(64 * 1024 * 1024);
    }));

  it("holds an exclusive command view and only adopts an explicit idle handoff", async () =>
    withFixture(async (f) => {
      const result = await f.program(`${seedMirror}
const first=createMirrorStaging(ctx.staging,ctx.repository);const source=seed(first);
const inode=fs.statSync(join(source,'source.txt')).ino;
const busy=createMirrorStaging(ctx.staging,ctx.repository)===undefined;
fs.mkdirSync(join(source,'.crabbox','runs'),{recursive:true});
fs.mkdirSync(join(source,'.crabbox','captures'));
fs.writeFileSync(join(source,'.crabbox','runs','output.log'),'native output');
first.staging.admitted(captureClaimNamespace(source));first.staging.settled();
const artifacts=preserveCrabboxArtifacts(source,ctx.repository);first.staging.preserved(artifacts);
first.finish();
const pruned=!fs.existsSync(join(source,'.crabbox'));
const preserved=fs.readFileSync(join(artifacts.destination.path,'runs','output.log'),'utf8')==='native output';
const next=createMirrorStaging(ctx.staging,ctx.repository);
const reused=next?.reused===true&&next.staging.root===first.staging.root;
const unchanged=fs.statSync(join(source,'source.txt')).ino===inode;
next.discard();
console.log(JSON.stringify({busy,reused,unchanged,pruned,preserved,removed:!fs.existsSync(first.staging.root)}));`);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        busy: true,
        reused: true,
        unchanged: true,
        pruned: true,
        preserved: true,
        removed: true,
      });
    }));

  it("preserves admitted, merely settled, and unverified writers instead of inferring idle authority", async () =>
    withFixture(async (f) => {
      const result = await f.program(`${seedMirror}
const states=[];
for(const state of ['admitted','settled','writers']){
  const root=join(ctx.root,state);const owner=createMirrorStaging(root,ctx.repository);const source=seed(owner);
  if(state==='writers')owner.staging.hold('writers');
  else {owner.staging.admitted(captureClaimNamespace(source));if(state==='settled')owner.staging.settled();}
  owner.finish();
  const next=createMirrorStaging(root,ctx.repository);
  states.push({state,reused:next!==undefined,retained:fs.readFileSync(join(source,'source.txt'),'utf8')==='uncommitted mirror source\\n'});
}
const unsafe=createMirrorStaging(join(ctx.root,'unsafe-discard'),ctx.repository);const unsafeSource=seed(unsafe);
unsafe.staging.admitted(captureClaimNamespace(unsafeSource));
let refused=false;try{unsafe.discard();}catch{refused=true;}
if(!refused||!fs.existsSync(unsafeSource))throw new Error('admitted source was discarded');
const unknown=createMirrorStaging(join(ctx.root,'unknown-output'),ctx.repository);const unknownSource=seed(unknown);
fs.mkdirSync(join(unknownSource,'.crabbox'));fs.writeFileSync(join(unknownSource,'.crabbox','unowned'),'keep');
unknown.staging.admitted(captureClaimNamespace(unknownSource));unknown.staging.settled();
unknown.staging.preserved(preserveCrabboxArtifacts(unknownSource,ctx.repository));
unknown.finish();
if(fs.existsSync(unknown.staging.root))throw new Error('settled native state was retained instead of ordinary disposal');
const replacement=createMirrorStaging(join(ctx.root,'unknown-output'),ctx.repository);
if(!replacement||replacement.reused)throw new Error('disposed native state did not rebuild cold');replacement.discard();
const damaged=createMirrorStaging(join(ctx.root,'damaged-output'),ctx.repository);const damagedSource=seed(damaged);
fs.mkdirSync(join(damagedSource,'.crabbox','runs'),{recursive:true});
fs.writeFileSync(join(damagedSource,'.crabbox','runs','output.log'),'original');fs.writeFileSync(join(damagedSource,'.crabbox','state'),'native state');
damaged.staging.admitted(captureClaimNamespace(damagedSource));damaged.staging.settled();
damaged.staging.preserved(preserveCrabboxArtifacts(damagedSource,ctx.repository));
fs.writeFileSync(join(damagedSource,'.crabbox','runs','output.log'),'changed');
let held=false;try{damaged.finish();}catch{held=true;}
if(!held||!fs.existsSync(damaged.staging.root))throw new Error('unverified output was disposed');
console.log(JSON.stringify(states));`);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        ["admitted", "settled", "writers"].map((state) => ({
          state,
          reused: false,
          retained: true,
        })),
      );
    }));

  it("releases crashed kernel locks without treating an admitted crash as settled", async () =>
    withFixture(async (f) => {
      const allocation = await f.program(
        "createMirrorStaging(ctx.staging,ctx.repository);throw new Error('allocation did not hold its lock');",
        `const {DatabaseSync}=await import('node:sqlite');
const execute=DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec=function(sql){const result=execute.call(this,sql);if(sql.includes('BEGIN EXCLUSIVE'))process.kill(process.pid,'SIGKILL');return result;};`,
      );
      expect(allocation.signal, allocation.stderr).toBe("SIGKILL");
      const afterAllocation = await f.program(`${seedMirror}
const owner=createMirrorStaging(ctx.staging,ctx.repository);seed(owner);owner.discard();`);
      expect(afterAllocation.status, afterAllocation.stderr).toBe(0);

      const idle = await f.program(
        `${seedMirror}
const owner=createMirrorStaging(ctx.staging,ctx.repository);const source=seed(owner);
const receipt=JSON.parse(fs.readFileSync(join(owner.staging.root,'staging.json'),'utf8'));
fs.writeSync(1,JSON.stringify({root:owner.staging.root,source,receipt}));
killOnRollback=true;owner.finish();throw new Error('idle owner unlocked without crashing');`,
        `const {DatabaseSync}=await import('node:sqlite');let killOnRollback=false;
const execute=DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec=function(sql){if(killOnRollback&&sql==='ROLLBACK')process.kill(process.pid,'SIGKILL');return execute.call(this,sql);};`,
      );
      expect(idle.signal, idle.stderr).toBe("SIGKILL");
      const idleStage = JSON.parse(idle.stdout) as Stage;
      expect((await f.recover(idleStage)).report.recovered).toBe(true);

      const admitted = await f.program(`${seedMirror}
const owner=createMirrorStaging(ctx.staging,ctx.repository);const source=seed(owner);
owner.staging.admitted(captureClaimNamespace(source));
const receipt=JSON.parse(fs.readFileSync(join(owner.staging.root,'staging.json'),'utf8'));
fs.writeSync(1,JSON.stringify({root:owner.staging.root,source,receipt}));process.kill(process.pid,'SIGKILL');`);
      expect(admitted.signal, admitted.stderr).toBe("SIGKILL");
      const admittedStage = JSON.parse(admitted.stdout) as Stage;
      expect((await f.recover(admittedStage)).report.recovered).toBe(false);
      const refused = await f.program(
        "if(createMirrorStaging(ctx.staging,ctx.repository)!==undefined)throw new Error('admitted mirror was adopted');",
      );
      expect(refused.status, refused.stderr).toBe(0);
      expect(readFileSync(join(admittedStage.source, "source.txt"), "utf8")).toBe(
        "uncommitted mirror source\n",
      );
    }));

  it("rebuilds corrupt cache or witness metadata without following a database symlink", async () =>
    withFixture(async (f) => {
      const result = await f.program(`${seedMirror}
const outcomes=[];const secret=join(ctx.root,'outside');fs.writeFileSync(secret,'private sentinel');
for(const fault of ['missing','changed','symlink','witness','journal']){
  const root=join(ctx.root,fault);const owner=createMirrorStaging(root,ctx.repository);seed(owner);owner.finish();
  const database=join(owner.staging.root,'mirror.sqlite');
  if(fault==='changed')fs.writeFileSync(database,'corrupted cache');
  else if(fault==='witness'){
    const path=join(owner.staging.root,'staging.json');const receipt=JSON.parse(fs.readFileSync(path,'utf8'));
    receipt.witness={gitDir:join(ctx.repository,'.git'),ref:'refs/heads/main',commit:'0'.repeat(40)};
    fs.writeFileSync(path,JSON.stringify(receipt));
  }
  else if(fault==='journal')fs.writeFileSync(database+'-journal','unsettled data');
  else {fs.rmSync(database);if(fault==='symlink')fs.symlinkSync(secret,database);}
  const next=createMirrorStaging(root,ctx.repository);
  outcomes.push({fault,cold:next?.reused===false,replaced:next?.staging.root!==owner.staging.root,removed:!fs.existsSync(owner.staging.root)});
  next.discard();
}
console.log(JSON.stringify({outcomes,secret:fs.readFileSync(secret,'utf8')}));`);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        outcomes: ["missing", "changed", "symlink", "witness", "journal"].map((fault) => ({
          fault,
          cold: true,
          replaced: true,
          removed: true,
        })),
        secret: "private sentinel",
      });
    }));

  it("keeps idle mirrors during automatic discovery and reclaims them through explicit staging recovery", async () =>
    withFixture(async (f) => {
      const result = await f.program(`${seedMirror}
const owner=createMirrorStaging(ctx.staging,ctx.repository);seed(owner);owner.finish();
const discovery=discoverStaging(ctx.staging);
const automatic=await recoverDiscoveredStaging(ctx.staging,discovery,{binary:ctx.cli,cwd:ctx.repository});
if(automatic?.recovered||!fs.existsSync(owner.staging.root))throw new Error('automatic discovery disposed a reusable mirror');
const id=JSON.parse(fs.readFileSync(join(owner.staging.root,'staging.json'),'utf8')).id;
await runStagingCommand(['recover',id],ctx.staging,{binary:ctx.cli,cwd:ctx.repository});
if(fs.existsSync(owner.staging.root))throw new Error('explicit recovery retained disposable mirror');`);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ recovered: true });
      expect(readFileSync(f.calls, "utf8")).toBe("");
    }));

  it("bounds protected allocations and skips a corrupt oldest mirror when evicting idle copies", async () =>
    withFixture(async (f) => {
      const result = await f.program(`${seedMirror}
const protectedRoot=join(ctx.root,'protected');fs.mkdirSync(join(protectedRoot,'mirrors'),{recursive:true,mode:0o700});
for(let i=0;i<32;i++)fs.mkdirSync(join(protectedRoot,'mirrors',String(i).padStart(64,'0')),{mode:0o700});
const refused=createMirrorStaging(protectedRoot,ctx.repository)===undefined;
const namespaceVictim=join(ctx.root,'namespace-victim');fs.mkdirSync(namespaceVictim,{mode:0o700});
fs.writeFileSync(join(namespaceVictim,'sentinel'),'preserve victim');
const namespaceFallback=[];
for(const kind of ['symlink','file']){
  const root=join(ctx.root,'namespace-'+kind);fs.mkdirSync(root);
  if(kind==='symlink')fs.symlinkSync(namespaceVictim,join(root,'mirrors'));
  else fs.writeFileSync(join(root,'mirrors'),'preserve replacement');
  namespaceFallback.push(createMirrorStaging(root,ctx.repository)===undefined);
  if(kind==='symlink'&&fs.readlinkSync(join(root,'mirrors'))!==namespaceVictim)throw new Error('mirror namespace link changed');
}
if(fs.readFileSync(join(ctx.root,'namespace-file','mirrors'),'utf8')!=='preserve replacement')throw new Error('replacement namespace changed');
const old=[];
const corruptMetadata='artifacts-'+'0'.repeat(64)+'.json';
for(let i=0;i<33;i++){
  const repo=join(ctx.root,'repo-'+i);fs.mkdirSync(repo);
  const init=cp.spawnSync('git',['-C',repo,'init','--quiet','--template=']);if(init.status!==0)throw new Error('git init failed');
  const owner=createMirrorStaging(ctx.staging,repo);seed(owner);owner.finish();old.push(owner.staging.root);
  const receiptPath=join(owner.staging.root,'staging.json');const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
  receipt.mirror.lastUsed=i;fs.writeFileSync(receiptPath,JSON.stringify(receipt));
  if(i===0)fs.writeFileSync(join(owner.staging.root,corruptMetadata),'malformed recovery metadata');
}
console.log(JSON.stringify({refused,namespaceFallback,namespaceVictimPreserved:fs.readdirSync(namespaceVictim).length===1&&fs.readFileSync(join(namespaceVictim,'sentinel'),'utf8')==='preserve victim',protectedSlots:fs.readdirSync(join(protectedRoot,'mirrors')).filter(name=>name!=='.allocation.lock').length,slots:fs.readdirSync(join(ctx.staging,'mirrors')).filter(name=>name!=='.allocation.lock').length,surviving:old.filter(path=>fs.existsSync(path)).length,newest:fs.existsSync(old[32]),corruptRetained:fs.readFileSync(join(old[0],corruptMetadata),'utf8')==='malformed recovery metadata',healthyVictimRemoved:!fs.existsSync(old[1])}));`);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        refused: true,
        namespaceFallback: [true, true],
        namespaceVictimPreserved: true,
        protectedSlots: 32,
        slots: 32,
        surviving: 32,
        newest: true,
        corruptRetained: true,
        healthyVictimRemoved: true,
      });
    }));
});

function orderedDirectories(names: string[], position: "first" | "last") {
  return `const order=${JSON.stringify(names)};const originalDirectory=fs.opendirSync;
fs.opendirSync=(path,...args)=>{const directory=originalDirectory(path,...args);if(resolve(path)===resolve(ctx.staging)){const entries=[];for(let entry;(entry=directory.readSync());)entries.push(entry);const rank=(name)=>{const index=order.indexOf(name);return index<0?${position === "first" ? "order.length" : "-1"}:index;};entries.sort((left,right)=>rank(left.name)-rank(right.name)||left.name.localeCompare(right.name));let next=0;directory.readSync=()=>entries[next++]??null;}return directory;};`;
}

describe.skipIf(process.platform === "win32")(
  "staging recovery through the real producer and wrapper",
  () => {
    it(
      "recovers a real prepared capsule after its owner dies through the public wrapper",
      async () =>
        withFixture(async (f) => {
          const before = f.git("rev-parse", "HEAD");
          const stage = await f.prepare();
          expect(stage.receipt).toMatchObject({
            version: 2,
            state: "prepared",
            users: "none",
            durable: true,
          });
          const recovered = await f.recover(stage);
          expect(recovered.status, recovered.stderr + recovered.stdout).toBe(0);
          expect(recovered.report).toMatchObject({ id: stage.receipt.id, recovered: true });
          const policies = f.nodePolicies();
          expect(new Set(policies.map(({ entry }) => entry))).toEqual(
            new Set(["source-selection", "claims-cli"]),
          );
          for (const policy of policies) {
            expect(policy.nodeArgs, policy.entry).toEqual(resolveVitestNodeArgs());
          }
          expect(readdirSync(f.staging)).toEqual([]);
          expect(readFileSync(join(f.source, "source.txt"), "utf8")).toBe("retained source\n");
          expect(f.git("rev-parse", "HEAD")).toBe(before);
          expect(f.git("status", "--porcelain")).toBe("");
        }),
      60_000,
    );

    it(
      "keeps preparation callbacks and additional Git workspaces held without disabling them",
      async () =>
        withFixture(async (f) => {
          const config = join(f.root, "home", ".gitconfig");
          const callback = join(f.root, "callback.sh");
          const localRecoveryGuard = join(f.root, "local-recovery-guard.mjs");
          writeFileSync(
            localRecoveryGuard,
            String.raw`import { registerHooks } from "node:module";
registerHooks({ load(url, context, nextLoad) {
  const path = new URL(url).pathname;
  if (/\/plugin-sdk\/process-runtime\.(?:ts|js)$/.test(path)) {
    throw new Error("Protected local recovery loaded the command runtime");
  }
  return nextLoad(url, context);
} });
`,
          );
          const localRecoveryEnv = {
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS,
              `--import=${pathToFileURL(localRecoveryGuard).href}`,
            ]
              .filter(Boolean)
              .join(" "),
          };
          writeFileSync(callback, "#!/bin/sh\nprintf 'fixture-token\\000'\n", { mode: 0o700 });
          let first: Stage | undefined;
          for (const [section, key] of [
            ["core", "fsmonitor"],
            ["core", "hooksPath"],
            ['filter "fixture"', "process"],
            ["diff", "external"],
          ] as const) {
            f.stage(`${section}.${key}`);
            const bytes = `[${section}]\n${key} = ${JSON.stringify(callback)}\n`;
            writeFileSync(config, bytes);
            if (section.startsWith("filter ")) {
              f.stage("filter.process-unused");
              const unused = await f.prepare();
              expect(unused.receipt.hold).toBeUndefined();
              expect((await f.recover(unused)).report.recovered).toBe(true);
              writeFileSync(join(f.source, ".gitattributes"), "source.txt filter=fixture\n");
              f.stage("filter.process-used");
            }
            const stage = await f.prepare(
              admit +
                "cap.staging.settled();cap.staging.hold('artifacts');cap.staging.hold('claims');",
            );
            first ??= stage;
            expect(stage.receipt).toMatchObject({
              version: 2,
              state: "settled",
              users: "settled",
              hold: "writers",
            });
            const recovery = await f.wrapper(["recover", stage.receipt.id], localRecoveryEnv);
            expect(recovery.status, recovery.stderr).toBe(1);
            expect(recovery.stdout, recovery.stderr).not.toBe("");
            expect(JSON.parse(recovery.stdout)).toMatchObject({
              recovered: false,
              reason: expect.stringContaining("settlement is unverified"),
            });
            expect(readFileSync(config, "utf8")).toBe(bytes);
            if (section.startsWith("filter ")) {
              f.stage("filter.process-deleted-source");
              const sourceFile = join(f.source, "source.txt");
              const retained = readFileSync(sourceFile);
              rmSync(sourceFile);
              const deleted = await f.prepare();
              expect(deleted.receipt.hold).toBe("writers");
              expect(
                JSON.parse(readFileSync(join(deleted.root, "manifest.json"), "utf8")).source
                  .deleted,
              ).toContain("source.txt");
              expect((await f.recover(deleted)).report.recovered).toBe(false);
              writeFileSync(sourceFile, retained);
            }
            rmSync(join(f.source, ".gitattributes"), { force: true });
          }
          for (const driver of ["unset", "unspecified"]) {
            f.stage(`filter-${driver}`);
            writeFileSync(config, `[filter "${driver}"]\nprocess = ${JSON.stringify(callback)}\n`);
            writeFileSync(join(f.source, ".gitattributes"), `source.txt filter=${driver}\n`);
            expect(f.git("check-attr", "filter", "--", "source.txt")).toBe(
              `source.txt: filter: ${driver}`,
            );
            const ambiguous = await f.prepare();
            expect(ambiguous.receipt.hold).toBe("writers");
            expect((await f.recover(ambiguous)).report.recovered).toBe(false);
          }
          rmSync(join(f.source, ".gitattributes"));
          f.stage("fsmonitor-disabled");
          writeFileSync(config, "[core]\nfsmonitor = false\n");
          expect((await f.recover(first!)).report.recovered).toBe(false);
          const disabled = await f.prepare();
          expect(disabled.receipt.hold).toBeUndefined();
          expect((await f.recover(disabled)).report.recovered).toBe(true);
          f.stage("additional-git-workspace");
          const additional = await f.prepare("", { localGitSeed: true });
          expect(additional.receipt.hold).toBe("writers");
          expect((await f.recover(additional)).report.recovered).toBe(false);
          f.stage("old-receipt");
          const earlier = await f.prepare();
          writeFileSync(
            join(earlier.root, "staging.json"),
            JSON.stringify({ ...f.receipt(earlier), version: 1 }),
          );
          expect((await f.recover(earlier)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("invalid metadata"),
          });
        }),
      120_000,
    );

    it(
      "holds admitted writers and requires explicit retry for settled diagnostics",
      async () =>
        withFixture(async (f) => {
          const admitted = await f.prepare(admit + diagnostics);
          const held = await f.recover(admitted);
          expect(held.report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("settlement was not recorded"),
          });
          expect(readFileSync(join(admitted.source, ".crabbox/runs/lease/output.bin"))).toEqual(
            artifactBytes,
          );
          const settled = await f.prepare(admit + diagnostics + "cap.staging.settled();");
          const automatic = await f.automatic();
          expect(
            automatic.discovery.entries.find((entry) => entry.id === settled.receipt.id)?.status,
          ).toBe("protected");
          expect(automatic.result).toBeUndefined();
          expect(existsSync(join(f.source, ".crabbox/wrapper-artifacts"))).toBe(false);
          const recovered = await f.recover(settled);
          expect(recovered.report.recovered, recovered.stdout + recovered.stderr).toBe(true);
          const [destination] = readdirSync(join(f.source, ".crabbox/wrapper-artifacts"));
          expect(
            readFileSync(
              join(f.source, ".crabbox/wrapper-artifacts", destination!, "runs/lease/output.bin"),
            ),
          ).toEqual(artifactBytes);
          expect(existsSync(admitted.root)).toBe(true);
        }),
      90_000,
    );

    it.each(["automatic", "removing"] as const)(
      "holds corrupted preserved artifacts during %s recovery",
      async (mode) =>
        withFixture(async (f) => {
          const stage = await f.prepare(
            admit +
              diagnostics +
              "cap.staging.settled();" +
              preserve +
              (mode === "removing" ? interruptedRemoval("none") : ""),
          );
          const saved = join(stage.destination!, "runs/lease/output.bin");
          writeFileSync(saved, "changed saved diagnostics");
          const result =
            mode === "automatic" ? (await f.automatic()).result : (await f.recover(stage)).report;
          expect(result).toMatchObject({
            recovered: false,
            reason: expect.stringMatching(/artifact/i),
          });
          expect(existsSync(stage.root)).toBe(true);
          expect(readFileSync(saved, "utf8")).toBe("changed saved diagnostics");
          expect(readFileSync(join(stage.source, ".crabbox/runs/lease/output.bin"))).toEqual(
            artifactBytes,
          );
          expect(readdirSync(join(f.source, ".crabbox/wrapper-artifacts"))).toHaveLength(1);
        }),
      90_000,
    );

    it(
      "retries preservation after artifact evidence was written but its receipt update failed",
      async () =>
        withFixture(async (f) => {
          const stage = await f.prepare(
            admit +
              diagnostics +
              "cap.staging.settled();" +
              `
artifacts=preserveCrabboxArtifacts(cap.directory,ctx.repository);
const originalRename=fs.renameSync;let interrupted=false;
fs.renameSync=(from,to)=>{if(to===join(cap.staging.root,'staging.json')){interrupted=true;throw new Error('fixture interrupted artifact publication');}return originalRename(from,to);};
syncBuiltinESMExports();try{cap.staging.preserved(artifacts);}catch(error){if(!interrupted)throw error;}finally{fs.renameSync=originalRename;syncBuiltinESMExports();}
if(!interrupted)throw new Error('fixture did not interrupt artifact publication');`,
          );
          expect(stage.receipt.state).toBe("settled");
          expect(
            readdirSync(stage.root).filter((name) => /^artifacts-[a-f0-9]{64}\.json$/u.test(name)),
          ).toHaveLength(1);
          expect((await f.recover(stage)).report.recovered).toBe(true);
          expect(existsSync(stage.root)).toBe(false);
          expect(readFileSync(join(stage.destination!, "runs/lease/output.bin"))).toEqual(
            artifactBytes,
          );
        }),
      90_000,
    );

    it(
      "holds claim-bound stages and changed namespaces without rewriting claims",
      async () =>
        withFixture(async (f) => {
          const bound = await f.prepare();
          f.inventory([{ leaseId: "cbx_bound_fixture", repoRoot: bound.source }]);
          const held = await f.recover(bound);
          expect(held.report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("cbx_bound_fixture"),
          });
          expect(f.receipt(bound).hold).toBe("claims");
          expect(existsSync(bound.root)).toBe(true);
          f.inventory();
          expect((await f.automatic()).result).toBeUndefined();
          expect((await f.recover(bound)).report.recovered).toBe(true);
          const changed = await f.prepare();
          const calls = readFileSync(f.calls, "utf8");
          const wrongNamespace = await f.recover(changed, [], {
            XDG_STATE_HOME: join(f.root, "other-state"),
          });
          expect(wrongNamespace.report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("location changed"),
          });
          expect(readFileSync(f.calls, "utf8")).toBe(calls);
          expect((await f.recover(changed)).report.recovered).toBe(true);
          for (const line of readFileSync(f.calls, "utf8").trim().split("\n")) {
            expect(JSON.parse(line)).toEqual(["claims", "list", "--json"]);
          }
        }),
      120_000,
    );

    it(
      "allows only expected omissions after interrupted removal",
      async () =>
        withFixture(async (f) => {
          const premature = await f.prepare();
          rmSync(join(premature.source, "source.txt"));
          expect((await f.recover(premature)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("missing before disposal"),
          });
          for (const removed of ["file", "payload"] as const) {
            const partial = await f.prepare(interruptedRemoval(removed));
            expect(partial.receipt.state).toBe("removing");
            const recovered = await f.recover(partial);
            expect(recovered.report.recovered, recovered.stdout + recovered.stderr).toBe(true);
          }
          const added = await f.prepare(interruptedRemoval("file"));
          writeFileSync(join(added.source, "unexpected.txt"), "new bytes must survive\n");
          expect((await f.recover(added)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("gained an entry"),
          });
          expect(readFileSync(join(added.source, "unexpected.txt"), "utf8")).toBe(
            "new bytes must survive\n",
          );
        }),
      120_000,
    );

    it(
      "requires an independent retained ref with exact dirty bytes, modes, symlinks, and deletions",
      async () =>
        withFixture(async (f) => {
          writeFileSync(join(f.source, "exec.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
          symlinkSync("source.txt", join(f.source, "link"));
          writeFileSync(join(f.source, "removed.txt"), "old source\n");
          f.commit();
          writeFileSync(join(f.source, "source.txt"), "unique dirty source\n");
          rmSync(join(f.source, "removed.txt"));
          const stage = await f.prepare("", {
            paths: ["source.txt", "exec.sh", "link", "removed.txt"],
          });
          expect(lstatSync(join(stage.source, "exec.sh")).mode & 0o100).toBe(0o100);
          expect(readlinkSync(join(stage.source, "link"))).toBe("source.txt");
          expect((await f.recover(stage)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("source.txt"),
          });
          const witness = join(f.root, "retained-source");
          mkdirSync(witness);
          f.initialize(witness);
          writeFileSync(join(witness, "source.txt"), "unique dirty source\n");
          writeFileSync(join(witness, "exec.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
          symlinkSync("wrong-target", join(witness, "link"));
          writeFileSync(join(witness, "unselected.txt"), "additional retained paths are allowed\n");
          f.commit(witness);
          const selected = ["--witness-repo", witness, "--witness-ref", "refs/heads/main"];
          expect((await f.recover(stage, selected)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("exec.sh"),
          });
          chmodSync(join(witness, "exec.sh"), 0o755);
          f.commit(witness);
          expect((await f.recover(stage, selected)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("link"),
          });
          rmSync(join(witness, "link"));
          symlinkSync("source.txt", join(witness, "link"));
          writeFileSync(join(witness, "removed.txt"), "deletion must also be retained\n");
          f.commit(witness);
          expect((await f.recover(stage, selected)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("deletion"),
          });
          rmSync(join(witness, "removed.txt"));
          f.commit(witness);
          rmSync(f.source, { recursive: true });
          const recovered = await f.recover(stage, selected);
          expect(recovered.report.recovered, recovered.stdout + recovered.stderr).toBe(true);
          expect(readFileSync(join(witness, "source.txt"), "utf8")).toBe("unique dirty source\n");
          expect(existsSync(f.source)).toBe(false);
        }),
      120_000,
    );

    it(
      "protects live or uncertain owner PIDs, substituted paths, and retained recovery locks",
      async () =>
        withFixture(async (f) => {
          const stage = await f.prepare();
          const receiptFile = join(stage.root, "staging.json"),
            original = readFileSync(receiptFile, "utf8");
          writeFileSync(
            receiptFile,
            JSON.stringify({ ...JSON.parse(original), ownerPid: process.pid }),
          );
          expect((await f.recover(stage)).report.reason).toContain("live or cannot be checked");
          writeFileSync(receiptFile, original);
          const uncertain = await f.program(
            `process.exitCode=await runStagingCommand(['recover',${JSON.stringify(stage.receipt.id)}],ctx.staging,{binary:ctx.cli,cwd:ctx.repository});`,
            `const originalKill=process.kill;process.kill=(pid,signal)=>{if(pid===${stage.receipt.ownerPid}&&signal===0)throw Object.assign(new Error('fixture denied owner lookup'),{code:'EPERM'});return originalKill(pid,signal);};`,
          );
          expect(JSON.parse(uncertain.stdout)).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("cannot be checked"),
          });
          const lock = join(stage.root, "recovery.lock");
          mkdirSync(lock);
          writeFileSync(
            join(lock, "owner.json"),
            JSON.stringify({ pid: stage.receipt.ownerPid, generation: "interrupted-fixture" }),
          );
          expect((await f.recover(stage)).report.reason).toContain("interrupted recovery");
          expect(existsSync(lock)).toBe(true);
          const replaced = await f.prepare(),
            saved = replaced.root + "-saved";
          const bytes = readFileSync(join(replaced.root, "staging.json"));
          renameSync(replaced.root, saved);
          mkdirSync(replaced.root);
          writeFileSync(join(replaced.root, "staging.json"), bytes);
          expect((await f.recover(replaced)).report).toMatchObject({ recovered: false });
          expect(readFileSync(join(saved, "payload/source/source.txt"), "utf8")).toBe(
            "retained source\n",
          );
        }),
      120_000,
    );

    it(
      "allows only one concurrent recovery owner and detects changed receipts during verification",
      async () =>
        withFixture(async (f) => {
          const stage = await f.prepare(),
            gate = { ready: join(f.root, "claims-ready"), release: join(f.root, "claims-release") };
          f.inventory([], gate);
          const first = f.recover(stage);
          await f.waitFor(gate.ready);
          expect((await f.recover(stage)).report.reason).toContain("interrupted recovery");
          writeFileSync(gate.release, "release");
          expect((await first).report.recovered).toBe(true);
          f.inventory();
          const changed = await f.prepare();
          rmSync(gate.ready);
          rmSync(gate.release);
          f.inventory([], gate);
          const recovering = f.recover(changed);
          await f.waitFor(gate.ready);
          writeFileSync(
            join(changed.root, "staging.json"),
            JSON.stringify({ ...f.receipt(changed), hold: "writers" }),
          );
          writeFileSync(gate.release, "release");
          expect((await recovering).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("ownership changed"),
          });
          expect(existsSync(changed.root)).toBe(true);
        }),
      120_000,
    );

    it(
      "protects FIFO receipts without reading or replacing them",
      async () =>
        withFixture(async (f) => {
          f.stage("prepare-fifo");
          const fifo = await f.prepare(),
            receipt = join(fifo.root, "staging.json");
          rmSync(receipt);
          f.stage("mkfifo");
          const made = await f.command("mkfifo", [receipt]);
          expect(made.status, made.stderr).toBe(0);
          f.stage("recover-fifo");
          expect((await f.recover(fifo)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("invalid metadata"),
          });
          expect(lstatSync(receipt).isFIFO()).toBe(true);
        }),
      90_000,
    );

    it(
      "keeps real full-worktree registrations and hook outputs protected",
      async () =>
        withFixture(async (f) => {
          const hook = join(f.source, ".git/hooks/post-checkout");
          mkdirSync(join(f.source, ".git/hooks"), { recursive: true });
          writeFileSync(hook, "#!/bin/sh\nprintf 'hook-owned bytes' > hook-output.txt\n", {
            mode: 0o700,
          });
          const created = await f.program(
            `const owner=createStaging(ctx.staging,ctx.repository,'worktree');const source=join(owner.payload,'source');const added=cp.spawnSync('git',['-C',ctx.repository,'worktree','add','--detach',source,'HEAD'],{stdio:'pipe'});if(added.status!==0)throw new Error(added.stderr.toString());owner.admitted(captureClaimNamespace(source));owner.settled();owner.preserved(preserveCrabboxArtifacts(source,ctx.repository));fs.writeSync(1,JSON.stringify({root:owner.root,source,receipt:JSON.parse(fs.readFileSync(join(owner.root,'staging.json'),'utf8'))}));process.kill(process.pid,'SIGKILL');`,
          );
          expect(created.signal, created.stderr).toBe("SIGKILL");
          const stage = JSON.parse(created.stdout) as Stage;
          const registered = f.git("worktree", "list", "--porcelain");
          expect(registered).toContain(stage.source);
          expect((await f.recover(stage)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("hooks or filters"),
          });
          expect(f.git("worktree", "list", "--porcelain")).toBe(registered);
          expect(readFileSync(join(stage.source, "hook-output.txt"), "utf8")).toBe(
            "hook-owned bytes",
          );
        }),
      90_000,
    );

    it(
      "recovers an independent candidate without replacing an unknown discovery cursor",
      async () =>
        withFixture(async (f) => {
          const stage = await f.prepare(),
            cursor = join(f.staging, "openclaw-crabbox-sync-discovery");
          mkdirSync(cursor);
          writeFileSync(join(cursor, "operator-note"), "unknown cursor bytes\n");
          expect((await f.automatic()).result).toMatchObject({
            id: stage.receipt.id,
            recovered: true,
          });
          expect(readdirSync(cursor)).toEqual(["operator-note"]);
          expect(readFileSync(join(cursor, "operator-note"), "utf8")).toBe(
            "unknown cursor bytes\n",
          );
        }),
      60_000,
    );

    it(
      "advances past a dirty candidate so the following clean candidate can recover",
      async () =>
        withFixture(async (f) => {
          writeFileSync(join(f.source, "source.txt"), "unretained dirty source\n");
          const dirty = await f.prepare();
          writeFileSync(join(f.source, "source.txt"), "retained source\n");
          const clean = await f.prepare();
          const result = await f.program(
            `const results=[];for(let i=0;i<2;i++){const discovery=discoverStaging(ctx.staging);results.push(await recoverDiscoveredStaging(ctx.staging,discovery,{binary:ctx.cli,cwd:ctx.repository}));}console.log(JSON.stringify(results));`,
            orderedDirectories([basename(dirty.root), basename(clean.root)], "first"),
          );
          expect(result.status, result.stderr).toBe(0);
          expect(JSON.parse(result.stdout)).toMatchObject([
            { id: dirty.receipt.id, recovered: false },
            { id: clean.receipt.id, recovered: true },
          ]);
          expect(readFileSync(join(dirty.source, "source.txt"), "utf8")).toBe(
            "unretained dirty source\n",
          );
          expect(existsSync(clean.root)).toBe(false);
        }),
      90_000,
    );

    it(
      "reaches a candidate beyond 64 protected entries over bounded metadata-only discovery passes",
      async () =>
        withFixture(async (f) => {
          const stage = await f.prepare("", {
            before: "for(let i=0;i<64;i++)createStaging(ctx.staging,ctx.repository,'worktree');",
          });
          const measurement = await f.program(
            `
const passes=[];
for(let pass=0;pass<128&&fs.existsSync(${JSON.stringify(stage.root)});pass++){
  counters={headers:0,bytes:0,payload:0,commands:0,hashes:0,osReads:0,osBytes:0,osCommands:0,osHashes:0,osHashBytes:0};phase='discover';
  const discovery=discoverStaging(ctx.staging);phase='recover';
  const metrics={...counters,entries:discovery.entries.length,elapsedMs:discovery.elapsedMs,statuses:discovery.entries.map(entry=>entry.status)};
  const result=await recoverDiscoveredStaging(ctx.staging,discovery,{binary:ctx.cli,cwd:ctx.repository});
  phase='idle';passes.push({...metrics,recovered:result?.recovered===true});
}
console.log(JSON.stringify({passes,remaining:fs.existsSync(${JSON.stringify(stage.root)})}));`,
            `
let phase='idle';let counters;let observedBoot='',observedNamespace='';const descriptors=new Map();
const originalOpen=fs.openSync,originalRead=fs.readSync,originalClose=fs.closeSync;
fs.openSync=(path,...args)=>{const fd=originalOpen(path,...args);descriptors.set(fd,String(path));if(phase==='discover'){if(basename(String(path))==='staging.json')counters.headers++;if(String(path).includes('/payload'))counters.payload++;}return fd;};
fs.readSync=(fd,...args)=>{const count=originalRead(fd,...args);if(phase==='discover'&&descriptors.has(fd)){if(descriptors.get(fd)==='/proc/sys/kernel/random/boot_id'){counters.osReads++;counters.osBytes+=count;if(Buffer.isBuffer(args[0])&&args[0].length<=128)observedBoot=args[0].subarray(0,count).toString('utf8').trim();}else counters.bytes+=count;}return count;};
fs.closeSync=(fd)=>{descriptors.delete(fd);return originalClose(fd);};
const originalReadlink=fs.readlinkSync;fs.readlinkSync=(path,...args)=>{const value=originalReadlink(path,...args);if(phase==='discover'&&path==='/proc/self/ns/pid'){counters.osReads++;counters.osBytes+=Buffer.byteLength(String(value));if(Buffer.byteLength(String(value))<=128)observedNamespace=String(value);}return value;};
for(const name of ['lstatSync','statSync','readFileSync','readdirSync','readlinkSync']){const original=fs[name];fs[name]=(path,...args)=>{if(phase==='discover'&&String(path).includes('/payload'))counters.payload++;return original(path,...args);};}
${orderedDirectories([basename(stage.root)], "last")}
for(const name of ['spawn','spawnSync','execFileSync']){const original=cp[name];cp[name]=(...args)=>{const options=args[2];const bootProbe=phase==='discover'&&process.platform==='darwin'&&name==='spawnSync'&&args[0]==='/usr/sbin/sysctl'&&JSON.stringify(args[1])===JSON.stringify(['-n','kern.bootsessionuuid'])&&options?.encoding==='utf8'&&options.env&&Object.keys(options.env).length===0&&options.timeout>0&&options.timeout<=1000&&options.maxBuffer>0&&options.maxBuffer<=1024;if(phase==='discover'){if(bootProbe)counters.osCommands++;else counters.commands++;}const result=original(...args);if(bootProbe&&typeof result.stdout==='string'){observedBoot=result.stdout.trim();counters.osBytes+=Buffer.byteLength(result.stdout);}return result;};}
const originalHash=crypto.createHash;crypto.createHash=(algorithm,...args)=>{const hash=originalHash(algorithm,...args);if(phase==='discover'){const metrics=counters;metrics.hashes++;const update=hash.update.bind(hash),digest=hash.digest.bind(hash);let updates=0,identity=false,size=0,finished=false;hash.update=(data,...options)=>{updates++;size=typeof data==='string'?Buffer.byteLength(data):0;identity=updates===1&&algorithm==='sha256'&&typeof data==='string'&&size<=256&&observedBoot.length===36&&(process.platform==='darwin'||observedNamespace.startsWith('pid:['))&&data===process.platform+':'+observedBoot.toLowerCase()+':'+observedNamespace;return update(data,...options);};hash.digest=(...options)=>{if(!finished&&identity){metrics.hashes--;metrics.osHashes++;metrics.osHashBytes+=size;}finished=true;return digest(...options);};}return hash;};`,
            120_000,
          );
          expect(measurement.status, measurement.stderr).toBe(0);
          const report = JSON.parse(measurement.stdout) as {
            passes: {
              headers: number;
              bytes: number;
              payload: number;
              commands: number;
              hashes: number;
              osReads: number;
              osBytes: number;
              osCommands: number;
              osHashes: number;
              osHashBytes: number;
              entries: number;
              elapsedMs: number;
              statuses: string[];
              recovered: boolean;
            }[];
            remaining: boolean;
          };
          expect(report.remaining).toBe(false);
          expect(report.passes.length).toBeGreaterThan(1);
          expect(report.passes[0]!.statuses.every((status) => status === "protected")).toBe(true);
          expect(report.passes.filter((pass) => pass.recovered)).toHaveLength(1);
          // Classify only the observed boot/PID-namespace digest as bounded OS
          // metadata. No discovery pass is run before measurement or prewarmed.
          expect(report.passes.reduce((sum, pass) => sum + pass.osHashes, 0)).toBe(1);
          expect(report.passes.reduce((sum, pass) => sum + pass.osCommands, 0)).toBe(
            process.platform === "darwin" ? 1 : 0,
          );
          for (const pass of report.passes) {
            expect(pass.headers).toBeLessThanOrEqual(64);
            expect(pass.entries).toBeLessThanOrEqual(64);
            expect(pass).toMatchObject({ payload: 0, commands: 0, hashes: 0 });
            expect(pass.bytes).toBeLessThanOrEqual(65 * 32 * 1024);
            expect(pass.osReads).toBeLessThanOrEqual(2);
            expect(pass.osBytes).toBeLessThanOrEqual(256);
            expect(pass.osHashBytes).toBeLessThanOrEqual(256);
          }
          expect(readFileSync(f.calls, "utf8").trim().split("\n")).toHaveLength(2);
          console.info(
            "Staging discovery metadata measurements: " +
              JSON.stringify(
                report.passes.map(
                  ({
                    headers,
                    bytes,
                    elapsedMs,
                    osReads,
                    osBytes,
                    osCommands,
                    osHashes,
                    osHashBytes,
                  }) => ({
                    headers,
                    bytes,
                    elapsedMs,
                    osReads,
                    osBytes,
                    osCommands,
                    osHashes,
                    osHashBytes,
                  }),
                ),
              ),
          );
        }),
      180_000,
    );
  },
);
