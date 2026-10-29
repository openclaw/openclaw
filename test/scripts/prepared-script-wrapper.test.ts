import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  preparedScriptWrapperEnv,
  preparedScriptWrapperPreload,
} from "./prepared-script-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("loads a large file-backed mapping with real source guards and restores exact preload bytes", () => {
  const root = tempDirs.make("prepared wrapper mapping ");
  const source = join(root, "source.mjs");
  const prepared = join(root, "prepared.mjs");
  const dependency = join(root, "dependency.mjs");
  const preparedDependency = join(root, "prepared-dependency.mjs");
  const preload = join(root, "wrapper-preload.mjs");
  const virtualSource = join(root, "virtual-source.mjs");
  const preparedVirtual = join(root, "prepared-virtual.mjs");
  writeFileSync(preparedVirtual, 'export default "dynamic virtual dependency";');
  writeFileSync(source, 'throw new Error("unprepared source loaded");');
  writeFileSync(dependency, 'throw new Error("unprepared dependency loaded");');
  writeFileSync(preparedDependency, 'export default "prepared dependency";');
  writeFileSync(
    prepared,
    [
      'import value from "./dependency.mjs";',
      'import { pathToFileURL } from "node:url";',
      'if (import.meta.url !== pathToFileURL(process.argv[1]).href) throw new Error("source main guard lost");',
      'console.log(value, (await import("./virtual-source.mjs")).default);',
    ].join("\n"),
  );
  const entries: Array<readonly [URL, URL]> = [
    [pathToFileURL(source), pathToFileURL(prepared)],
    [pathToFileURL(dependency), pathToFileURL(preparedDependency)],
    ...Array.from(
      { length: 2000 },
      (_, index) =>
        [
          pathToFileURL(join(root, `source-unused-${index}.mjs`)),
          pathToFileURL(join(root, `prepared-unused-${index}.mjs`)),
        ] as const,
    ),
  ];
  const virtualModules: Array<readonly [URL, URL]> = [
    [pathToFileURL(virtualSource), pathToFileURL(preparedVirtual)],
  ];
  const env = preparedScriptWrapperEnv(
    entries,
    { NODE_OPTIONS: "--no-warnings" },
    virtualModules,
    preload,
  );
  const original = readFileSync(preload);
  expect(original.toString()).toBe(preparedScriptWrapperPreload(entries, virtualModules));
  expect(original.length).toBeGreaterThan(128 * 1024);
  expect(env.NODE_OPTIONS).toContain(pathToFileURL(preload).href);
  expect(env.NODE_OPTIONS).not.toContain("data:");
  expect(Buffer.byteLength(env.NODE_OPTIONS!)).toBeLessThan(4096);
  const invoke = () => spawnSync(process.execPath, [source], { env, encoding: "utf8" });
  const first = invoke();
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout.trim()).toBe("prepared dependency dynamic virtual dependency");
  rmSync(preload);
  try {
    const missing = invoke();
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("ERR_MODULE_NOT_FOUND");
  } finally {
    writeFileSync(preload, original);
  }
  expect(readFileSync(preload)).toEqual(original);
  const restored = invoke();
  expect(restored.status, restored.stderr).toBe(0);
  expect(restored.stdout.trim()).toBe("prepared dependency dynamic virtual dependency");
});

it("reports launch byte counts without retaining argument or environment values", async () => {
  const root = tempDirs.make("prepared-launch-diagnostic-");
  const secret = "fixture-secret-not-for-diagnostics";
  const args = ["--eval", secret];
  const env = { FIXTURE_SECRET: secret, EMPTY: "", OMITTED: undefined };
  const result = await runNodeScript(args, env, 1000, { executable: join(root, "missing-node") });
  expect(result.error).toBeDefined();
  expect(result.status).toBeNull();
  expect(result.signal).toBeNull();
  expect(result.launchDiagnostics).toEqual({
    argvBytes: [join(root, "missing-node"), ...args].reduce(
      (sum, value) => sum + Buffer.byteLength(value) + 1,
      0,
    ),
    environmentBytes:
      Buffer.byteLength("FIXTURE_SECRET=" + secret) + 1 + Buffer.byteLength("EMPTY=") + 1,
    largestArgumentBytes: Math.max(
      ...[join(root, "missing-node"), ...args].map((value) => Buffer.byteLength(value) + 1),
    ),
    largestEnvironmentEntryBytes: Buffer.byteLength("FIXTURE_SECRET=" + secret) + 1,
    environmentEntries: 2,
  });
  expect(JSON.stringify(result.launchDiagnostics)).not.toContain(secret);
  expect(JSON.stringify(result.launchDiagnostics)).not.toContain("FIXTURE_SECRET");
});
