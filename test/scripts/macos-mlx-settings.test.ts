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
      expect(
        fs
          .readFileSync(observed, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([["2300"], ["2300"], ["2180"]]);
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
