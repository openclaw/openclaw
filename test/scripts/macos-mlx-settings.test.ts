import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { hasMlxNativeProofInputs } from "../../scripts/ci-changed-scope.mjs";
import {
  projectMlxSettingsManifest,
  verifyMlxSettingsPackageProjection,
} from "../../scripts/lib/macos-mlx-settings-manifest.mts";
import { execNodeEvalSync } from "../../src/test-utils/node-process.js";

it("restricts the real settings test target through one manifest insertion", () => {
  const original = fs.readFileSync(
    new URL("../../apps/macos/Package.swift", import.meta.url),
    "utf8",
  );
  const projected = projectMlxSettingsManifest(original);
  const insertion = '            sources: ["MLXSettingsUpgradeTests.swift"],\n';
  expect(projected.split(insertion)).toHaveLength(2);
  expect(projected.replace(insertion, "")).toBe(original);
  expect(() => projectMlxSettingsManifest(projected)).toThrow(/Unsupported/);
  expect(() => projectMlxSettingsManifest(original + original)).toThrow(/Ambiguous/);
  expect(() =>
    projectMlxSettingsManifest(original.replace("OpenClawIPCTests", "OtherTests")),
  ).toThrow(/Ambiguous/);
});

const packageDump = () => ({
  name: "OpenClaw",
  dependencies: [
    { sourceControl: [{ identity: "dependency", requirement: { exact: ["1.0.0"] } }] },
  ],
  products: [{ name: "OpenClaw", targets: ["OpenClaw"], type: { executable: null } }],
  targets: [
    { name: "OpenClaw", type: "executable", dependencies: ["OpenClawKit"], settings: ["strict"] },
    {
      name: "OpenClawIPCTests",
      type: "test",
      dependencies: ["OpenClaw", "OpenClawKit"],
      path: "Tests/OpenClawIPCTests",
      sources: null as string[] | null,
      settings: ["strict", "SwiftTesting"],
      resources: [{ rule: "copy", path: "fixture.json" }],
    },
  ],
});

it("admits only the settings target source list in SwiftPM metadata", () => {
  const original = packageDump();
  const projected = structuredClone(original);
  projected.targets[1]!.sources = ["MLXSettingsUpgradeTests.swift"];
  expect(() => verifyMlxSettingsPackageProjection(original, projected)).not.toThrow();
  expect(original.targets[1]!.sources).toBeNull();
});

it.each([
  "production dependency",
  "production settings",
  "test dependency",
  "test settings",
  "test path",
  "test resource",
  "package dependency",
  "product",
  "extra target",
  "extra test source",
])("rejects a focused manifest that also changes %s", (change) => {
  const original = packageDump();
  const projected = structuredClone(original);
  projected.targets[1]!.sources = ["MLXSettingsUpgradeTests.swift"];
  switch (change) {
    case "production dependency":
      projected.targets[0]!.dependencies = [];
      break;
    case "production settings":
      projected.targets[0]!.settings = [];
      break;
    case "test dependency":
      projected.targets[1]!.dependencies = [];
      break;
    case "test settings":
      projected.targets[1]!.settings = [];
      break;
    case "test path":
      projected.targets[1]!.path = "OtherTests";
      break;
    case "test resource":
      projected.targets[1]!.resources = [];
      break;
    case "package dependency":
      projected.dependencies = [];
      break;
    case "product":
      projected.products = [];
      break;
    case "extra target":
      projected.targets.push(structuredClone(projected.targets[0]!));
      break;
    case "extra test source":
      projected.targets[1]!.sources.push("UnrelatedTests.swift");
      break;
  }
  expect(() => verifyMlxSettingsPackageProjection(original, projected)).toThrow(/package graph/);
});

it("rejects missing, duplicated or previously scoped SwiftPM test targets", () => {
  for (const variant of ["missing", "duplicated", "scoped"]) {
    const original = packageDump();
    if (variant === "missing") {
      original.targets.pop();
    }
    if (variant === "duplicated") {
      original.targets.push(structuredClone(original.targets[1]!));
    }
    if (variant === "scoped") {
      original.targets[1]!.sources = ["OtherTests.swift"];
    }
    expect(() => verifyMlxSettingsPackageProjection(original, original)).toThrow();
  }
});

it("prepares the stable producer with its full frozen workspace graph and own cwd", () => {
  const source = fs.readFileSync(
    new URL("../../scripts/test-macos-mlx-settings.mts", import.meta.url),
    "utf8",
  );
  const call = source.match(
    /await run\(\s*"pnpm",\s*(\[\s*"install"[\s\S]*?\]),\s*stable,\s*240_000,\s*\)/u,
  );
  expect(call).not.toBeNull();
  if (!call) {
    throw new Error("Missing source-owned stable install");
  }
  const args: unknown = JSON.parse(call[1]!.replace(/,\s*\]$/u, "]"));
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error("Install argv must be literal strings");
  }
  // Fake pnpm receives the actual preparer argv; it never installs anything.
  const observed = JSON.parse(
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...args],
      { encoding: "utf8", timeout: 5_000 },
    ),
  );
  expect(observed.slice(0, 4)).toEqual([
    "install",
    "--frozen-lockfile",
    "--prefer-offline",
    "--optional",
  ]);
  expect(observed).not.toContain("--filter");
  expect(observed).not.toContain("--filter-prod");
  expect(observed).toContain("--config.ignore-scripts=false");
  expect(observed).toContain("--config.enable-pre-post-scripts=true");
});

it.skipIf(process.platform === "win32")(
  "retains the original job clock across fresh Node owners",
  () => {
    const budgetURL = new URL("../../scripts/lib/native-ci-budget.mts", import.meta.url).href;
    const original = execFileSync(
      "python3",
      ["-I", "-S", "-c", "import time; print(time.monotonic())"],
      { encoding: "utf8", timeout: 5_000 },
    ).trim();
    expect(Number(original)).toBeGreaterThan(0);
    const program = `
import assert from 'node:assert/strict';
const {NativeCiBudget}=await import(${JSON.stringify(budgetURL)});
const budget=new NativeCiBudget(process.argv[1]);
assert(budget.timeout(27*60*1000)<=27*60*1000);
assert(budget.timeout(30*60*1000,true)<=30*60*1000);
console.log(JSON.stringify({pid:process.pid,started:budget.started}));
`;
    const launch = () =>
      JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", program, original], {
          encoding: "utf8",
          timeout: 15_000,
        }),
      );
    const first = launch();
    const second = launch();
    expect(first.started).toBe(original);
    expect(second.started).toBe(original);
    expect(second.pid).not.toBe(first.pid);
  },
);

it.skipIf(process.platform === "win32")(
  "keeps the original clock when fresh owners approach exhaustion",
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-budget-"));
    try {
      const python = execFileSync(
        "python3",
        ["-I", "-S", "-c", "import sys; print(sys.executable)"],
        {
          encoding: "utf8",
          timeout: 5_000,
        },
      ).trim();
      const clock = path.join(root, "now");
      const observed = path.join(root, "started");
      // Execute the owner's actual sampler; only its clock reading is controlled.
      fs.writeFileSync(
        path.join(root, "python3"),
        `#!${python}\nimport json,pathlib,sys,time\nassert sys.argv[1:4]==['-I','-S','-c']\nprogram=sys.argv[4]\nsys.argv=[sys.argv[0],*sys.argv[5:]]\nwith open(${JSON.stringify(observed)},'a') as output: output.write(json.dumps(sys.argv[1:])+'\\n')\ntime.monotonic=lambda:float(pathlib.Path(${JSON.stringify(clock)}).read_text())\nexec(compile(program,'<native-budget-sampler>','exec'))\n`,
        { mode: 0o700 },
      );
      const budgetURL = new URL("../../scripts/lib/native-ci-budget.mts", import.meta.url).href;
      const program = `
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
const {NativeCiBudget}=await import(${JSON.stringify(budgetURL)});
const before=performance.now();
const budget=new NativeCiBudget('2300');
const work=budget.timeout(120000),cleanup=budget.timeout(300000,true);
assert(budget.workEnd>=before+Number(process.argv[1])*1000);
assert(budget.cleanupEnd>=before+Number(process.argv[2])*1000);
assert(work>0&&work<=Number(process.argv[1])*1000);
assert(cleanup>0&&cleanup<=Number(process.argv[2])*1000);
console.log(JSON.stringify({pid:process.pid,started:budget.started,work,cleanup}));
`;
      const options = {
        encoding: "utf8" as const,
        env: { ...process.env, PATH: root + path.delimiter + process.env.PATH },
        timeout: 15_000,
      };
      fs.writeFileSync(clock, "3860");
      const first = JSON.parse(
        execFileSync(
          process.execPath,
          ["--input-type=module", "-e", program, "60", "240"],
          options,
        ),
      );
      fs.writeFileSync(clock, "3861");
      const second = JSON.parse(
        execFileSync(
          process.execPath,
          ["--input-type=module", "-e", program, "59", "239"],
          options,
        ),
      );
      expect(first.started).toBe("2300");
      expect(second.started).toBe(first.started);
      expect(second.pid).not.toBe(first.pid);
      const rejected = `import assert from 'node:assert/strict'; const {NativeCiBudget}=await import(${JSON.stringify(budgetURL)}); assert.throws(()=>new NativeCiBudget('NaN'),/Missing native job monotonic start/); assert.throws(()=>new NativeCiBudget('2180'),/Invalid or exhausted/);`;
      execFileSync(process.execPath, ["--input-type=module", "-e", rejected], options);
      const sourceURL = new URL("../../scripts/test-macos-mlx-settings.mts", import.meta.url).href;
      const terminalProgram = `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import {performance} from 'node:perf_hooks';
import {runInNewContext} from 'node:vm';
assert.equal(process.versions.bun,undefined);
const {NativeCiBudget}=await import(${JSON.stringify(budgetURL)});
const source=fs.readFileSync(new URL(${JSON.stringify(sourceURL)}),'utf8');
// Execute the owner's verifier and terminal admission, not a copied integrity loop.
const verifier=source.match(/  const verify = [\\s\\S]*?\\n  };/)?.[0];
const overlayVerifier=source.match(/    const verifyOverlays = [\\s\\S]*?\\n    };/)?.[0];
const overlayDeclaration=source.match(/const overlays = \\[[\\s\\S]*?\\n\\];/)?.[0];
const terminal=source.match(/    const consumerReceipt = [\\s\\S]*?    result.complete = true;/)?.[0];
assert(verifier && overlayVerifier && overlayDeclaration && terminal);
const root=${JSON.stringify(root)};
const stable=path.join(root,'stable'),current=path.join(root,'current'),proofDir=path.join(root,'proof');
const manifestPath='apps/macos/Package.swift';
const original=Buffer.from('original manifest\\n'),effective=Buffer.from('projected manifest\\n');
const blob=data=>createHash('sha1').update('blob '+data.length+'\\0').update(data).digest('hex');
const sha256=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const overlays=runInNewContext(overlayDeclaration+'; overlays');
const manifestProjections=new Map();
const tree=[{relative:'source.txt',mode:'100644',blob:blob(Buffer.from('source\\n'))},
  {relative:'linked.txt',mode:'120000',blob:blob(Buffer.from('source.txt'))},
  {relative:manifestPath,mode:'100644',blob:blob(original)}];
for(const dir of [stable,current]) {
  fs.mkdirSync(path.join(dir,'apps/macos'),{recursive:true});
  fs.writeFileSync(path.join(dir,'source.txt'),'source\\n',{mode:0o644});
  fs.symlinkSync('source.txt',path.join(dir,'linked.txt'));
  fs.writeFileSync(path.join(dir,manifestPath),effective,{mode:0o644});
  manifestProjections.set(dir,{originalBlob:blob(original),effectiveBlob:blob(effective)});
  for(const relative of overlays) {
    fs.mkdirSync(path.dirname(path.join(dir,relative)),{recursive:true});
    fs.writeFileSync(path.join(dir,relative),'overlay\\n');
  }
}
fs.mkdirSync(proofDir);
const receipt=path.join(proofDir,'settings-consumers.json');
const writeReceipt=(complete=true,resourcesRemoved=true)=>fs.writeFileSync(receipt,JSON.stringify({complete,resourcesRemoved}));
writeReceipt();
const budget=new NativeCiBudget('2300');
let now=budget.workEnd-1000,expireAfterOverlays=false;
Object.defineProperty(performance,'now',{value:()=>now,configurable:true});
const result={complete:false};
const trackedFs={...fs,readFileSync(file,...args) {
  const bytes=fs.readFileSync(file,...args);
  if(expireAfterOverlays && file===path.join(current,overlays.at(-1))) now=budget.cleanupEnd+1;
  return bytes;
}};
const actual=runInNewContext(stripTypeScriptTypes(verifier+'\\n'+overlayVerifier)+
  '; ({verify, complete: (code) => {'+terminal+'}})', {
  assert,Buffer,createHash,fs:trackedFs,path,budget,stable,current,proofDir,
  stableTree:tree,currentTree:tree,manifestProjections,mlxSettingsManifestPath:manifestPath,
  overlays,overlayHashes:Object.fromEntries(overlays.map(relative=>[relative,sha256(path.join(current,relative))])),
  sha256:file=>createHash('sha256').update(trackedFs.readFileSync(file)).digest('hex'),result,canRemove:false,
});
actual.verify(current,tree);
now=budget.workEnd+1;
assert.throws(()=>actual.verify(current,tree),/Native work budget exhausted/);
actual.complete(0);
assert.equal(result.complete,true);
const passed=['expired-work-retired-success','normal-verifier-work-bound'];
const check=(name,mutate,restore,pattern,code=0)=>{
  result.complete=false;
  mutate();
  assert.throws(()=>actual.complete(code),pattern,name);
  assert.equal(result.complete,false,name);
  restore();
  passed.push(name);
};
const file=path.join(current,'source.txt'),link=path.join(current,'linked.txt'),manifest=path.join(current,manifestPath);
check('changed-bytes',()=>fs.writeFileSync(file,'changed'),()=>fs.writeFileSync(file,'source\\n'),/Production input changed/);
check('changed-mode',()=>fs.chmodSync(file,0o755),()=>fs.chmodSync(file,0o644),/Source executable mode changed/);
check('escaping-link',()=>{fs.unlinkSync(link);fs.symlinkSync(path.join(root,'now'),link);},()=>{fs.unlinkSync(link);fs.symlinkSync('source.txt',link);},/Source link escapes/);
check('projected-manifest',()=>fs.writeFileSync(manifest,original),()=>fs.writeFileSync(manifest,effective),/Production input changed/);
const projection=manifestProjections.get(current);
check('original-manifest-identity',()=>{projection.originalBlob='0'.repeat(40);},()=>{projection.originalBlob=blob(original);},/Original manifest identity changed/);
for(const [name,dir] of [['stable-overlay',stable],['current-overlay',current]]) {
  const overlay=path.join(dir,overlays[0]);
  check(name,()=>fs.writeFileSync(overlay,'changed'),()=>fs.writeFileSync(overlay,'overlay\\n'),/Test overlay changed/);
}
check('failed-child',()=>{},()=>{},/Ordered settings proof failed/,7);
check('incomplete-child',()=>writeReceipt(false),()=>writeReceipt(),/resource retirement is unverified/);
check('unretired-child',()=>writeReceipt(true,false),()=>writeReceipt(),/resource retirement is unverified/);
check('cleanup-expired',()=>{now=budget.cleanupEnd+1;},()=>{now=budget.workEnd+1;},/Native cleanup budget exhausted/);
check('cleanup-expired-after-overlays',()=>{expireAfterOverlays=true;},()=>{expireAfterOverlays=false;now=budget.workEnd+1;},/Native cleanup budget exhausted/);
console.log(JSON.stringify(passed));
`;
      // This Node CLI verifier stays on Node when the surrounding suite uses Bun.
      expect(JSON.parse(execNodeEvalSync(terminalProgram, options))).toEqual([
        "expired-work-retired-success",
        "normal-verifier-work-bound",
        "changed-bytes",
        "changed-mode",
        "escaping-link",
        "projected-manifest",
        "original-manifest-identity",
        "stable-overlay",
        "current-overlay",
        "failed-child",
        "incomplete-child",
        "unretired-child",
        "cleanup-expired",
        "cleanup-expired-after-overlays",
      ]);
      expect(
        fs
          .readFileSync(observed, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([["2300"], ["2300"], ["2180"], ["2300"]]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "accepts fractional Python clock subtraction without extending either deadline",
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-budget-"));
    try {
      const started = 2300.123456789;
      const now = started + 10.25;
      const sample = [started + 27 * 60 - now, started + 30 * 60 - now];
      expect(sample[1]! - sample[0]!).not.toBe(180);
      fs.writeFileSync(
        path.join(root, "python3"),
        `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(sample))});\n`,
        { mode: 0o700 },
      );
      const url = new URL("../../scripts/lib/native-ci-budget.mts", import.meta.url).href;
      const program = `import assert from 'node:assert/strict'; import {performance} from 'node:perf_hooks'; const {NativeCiBudget}=await import(${JSON.stringify(url)}); const budget=new NativeCiBudget(${JSON.stringify(String(started))}); const after=performance.now(); assert(budget.workEnd<=after+${sample[0]! * 1000}); assert(budget.cleanupEnd<=after+${sample[1]! * 1000}); console.log('fractional-clock-bounded');`;
      expect(
        execFileSync(process.execPath, ["--input-type=module", "-e", program], {
          encoding: "utf8",
          env: { ...process.env, PATH: root + path.delimiter + process.env.PATH },
          timeout: 10_000,
        }),
      ).toContain("fractional-clock-bounded");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each([
  "scripts/test-macos-mlx-settings.mts",
  "scripts/lib/native-ci-budget.mts",
  "scripts/lib/macos-mlx-settings-manifest.mts",
  "scripts/test-macos-native.mts",
  "test/helpers/macos-mlx-settings-producer.ts",
  "apps/macos/Tests/OpenClawIPCTests/MLXSettingsUpgradeTests.swift",
])("selects the native proof owner for %s without a new public flag", (file) => {
  expect(hasMlxNativeProofInputs([file])).toBe(true);
});

it("uses source-owned validation and leaves the native producer unmocked", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../helpers/macos-mlx-settings-producer.ts", import.meta.url)),
    "utf8",
  );
  expect(source).toContain("validateTalkConfigResult(value)");
  expect(source).toContain("paths.CONFIG_PATH, rawURL");
  expect(source).toContain(
    "captureRuntimeConfigWithSource(snapshot.config, snapshot.sourceConfig)",
  );
  expect(source).not.toMatch(
    /vi\.|mock\(|readConfigFileSnapshotFromRaw|pluginValidation:\s*["'](?:skip|core-only)/,
  );
});
