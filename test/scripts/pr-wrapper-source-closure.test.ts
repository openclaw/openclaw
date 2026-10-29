import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copyPrWrapperSources, linkPrWrapperDependencies } from "./pr-wrapper.test-support.js";

const components = [
  "scripts/pr",
  "scripts/pr-lib",
  ...readFileSync("scripts/pr-lib/wrapper-components.txt", "utf8").trim().split("\n"),
];

it.each([
  "src/infra/gateway-state-owner.ts",
  "src/plugins/discovery.ts",
  "src/infra/sqlite-readonly-location.worker.ts",
])(
  "retains %s and its relative ESM runtime dependencies in the wrapper inventory",
  (entrypoint) => {
    const closure = collectRuntimeImportClosure(process.cwd(), [entrypoint], {
      includeDynamicImports: true,
    });
    expect(
      closure.filter(
        (file) =>
          !components.some((component) => file === component || file.startsWith(`${component}/`)),
      ),
    ).toEqual([]);
  },
);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("closes the extracted default Node runner and rejects a missing pinned dependency", () => {
  const root = tempDirs.make("openclaw-pr-runner-closure-");
  copyPrWrapperSources(root);
  linkPrWrapperDependencies(root);
  for (const resource of [
    "scripts/lib/pinned-bun.mts",
    "scripts/lib/openclaw-bun.json",
    "scripts/stage-openclaw-bun.sh",
  ]) {
    expect(components).toContain(resource);
  }
  const dependency = join(root, "scripts/lib/pinned-bun.mts");
  const original = readFileSync(dependency);
  const env = { ...process.env };
  delete env.OPENCLAW_TEST_RUNTIME;
  delete env.OPENCLAW_VITEST_RUNTIME;
  // Exercise the real default Node entry, not a mocked import or Bun path.
  // The missing target is deliberately rejected before any Vitest installation
  // or build preparation is needed by this inventory-only trust anchor.
  const invoke = () =>
    spawnSync(
      process.execPath,
      [join(root, "scripts/run-vitest.mts"), "./wrapper-closure-missing.test.ts"],
      {
        cwd: root,
        env,
        encoding: "utf8",
      },
    );
  rmSync(dependency);
  try {
    const missing = invoke();
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("pinned-bun.mts");
    expect(missing.stderr).toContain("ERR_MODULE_NOT_FOUND");
  } finally {
    writeFileSync(dependency, original);
  }
  expect(readFileSync(dependency)).toEqual(original);
  const restored = invoke();
  expect(restored.status, restored.stderr).toBe(1);
  expect(restored.stderr).toContain("explicit test/source file(s) not found");
  expect(restored.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  const selected = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { resolveVitestTestCommand } from "./scripts/lib/vitest-test-runtime.mts"; ' +
        'import { spawnSync } from "node:child_process"; ' +
        'const launch = resolveVitestTestCommand(["-e", "console.log(12345)"], {}); ' +
        'if (launch.command !== process.execPath) throw new Error("default must remain Node"); ' +
        'const child = spawnSync(launch.command, launch.args, { encoding: "utf8" }); ' +
        "process.stdout.write(child.stdout); process.exitCode = child.status;",
    ],
    { cwd: root, env, encoding: "utf8" },
  );
  expect(selected.status, selected.stderr).toBe(0);
  expect(selected.stdout.trim()).toBe("12345");
});

it("loads the inventory-only sqlite worker and owner and rejects the missing native-loss dependency", () => {
  const root = tempDirs.make("openclaw-pr-sqlite-closure-");
  copyPrWrapperSources(root);
  linkPrWrapperDependencies(root);
  const dependency = join(root, "src/state/openclaw-state-worker-native-loss.ts");
  const original = readFileSync(dependency);
  const invoke = () =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "--input-type=module",
        "-e",
        'await import("./src/infra/sqlite-readonly-location.worker.ts"); await import("./src/state/openclaw-state-worker-owner.ts"); console.log("sqlite worker and owner loaded");',
      ],
      { cwd: root, env: process.env, encoding: "utf8" },
    );
  const first = invoke();
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout.trim()).toBe("sqlite worker and owner loaded");
  rmSync(dependency);
  try {
    const missing = invoke();
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("openclaw-state-worker-native-loss");
    expect(missing.stderr).toContain("ERR_MODULE_NOT_FOUND");
  } finally {
    writeFileSync(dependency, original);
  }
  expect(readFileSync(dependency)).toEqual(original);
  const restored = invoke();
  expect(restored.status, restored.stderr).toBe(0);
  expect(restored.stdout.trim()).toBe("sqlite worker and owner loaded");
});
