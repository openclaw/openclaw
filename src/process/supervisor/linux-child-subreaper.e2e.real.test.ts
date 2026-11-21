import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bundleDirectory = join(repoRoot, "node_modules", ".tmp", "subreaper-e2e");
const driverBundle = join(bundleDirectory, "driver.mjs");
const driverSource = fileURLToPath(
  new URL("linux-child-subreaper.e2e.driver.test-support.ts", import.meta.url),
);

/** The shadow mounts an empty tmpfs over the launching shell's own /proc/<pid>/task,
 * so per-thread children files disappear while /proc/<pid>/stat stays readable. */
function selectShadowWrapper(): string | undefined {
  const candidates = process.getuid() === 0 ? ["unshare -m", "unshare -Urm"] : ["unshare -Urm"];
  for (const unshare of candidates) {
    const probe = spawnSync("sh", [
      "-c",
      unshare +
        " sh -c 'mount -t tmpfs none /proc/$$/task && test \"$(ls /proc/$$/task | wc -l)\" -eq 0'",
    ]);
    if (probe.status === 0) {
      return unshare;
    }
  }
  return undefined;
}

// "" only when the platform is not Linux or no shadow can be constructed there.
const shadowWrapper = process.platform === "linux" ? ((selectShadowWrapper() ?? "") as string) : "";

describe.skipIf(shadowWrapper === "")("real child subreaper e2e with children files absent", () => {
  beforeAll(() => {
    mkdirSync(bundleDirectory, { recursive: true });
    // A bundled driver runs as plain node without source-loader hooks, so the
    // dedicated-owner admission of the shipped anchor accepts the process.
    const bundle = spawnSync(join(repoRoot, "node_modules", ".bin", "esbuild"), [
      driverSource,
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--packages=external",
      "--outfile=" + driverBundle,
    ]);
    expect(bundle.status, bundle.stderr).toBe(0);
  });

  afterAll(() => {
    rmSync(bundleDirectory, { recursive: true, force: true });
  });

  it(
    "adopts, discovers, signals, natively reaps, and strictly drains an orphan without children files",
    { timeout: 60_000 },
    () => {
      const run = spawnSync(
        "sh",
        [
          "-c",
          shadowWrapper +
            " sh -c 'mount -t tmpfs none /proc/$$/task && exec node " +
            driverBundle +
            "'",
        ],
        { encoding: "utf8", timeout: 50_000 },
      );
      expect(run.stderr, run.stdout).toBe("");
      expect(run.status, run.stdout).toBe(0);
      for (const marker of [
        "per-thread children files: absent",
        "owner acquired",
        "exited with code 0",
        "discovered by owner enumeration with children files absent",
        "drain(SIGTERM) on the running adopted orphan returned",
        "drain() after orphan exit returned true",
        "gone (natively reaped)",
        "PASS: adoption, owner enumeration, signaling, native reaping, and completed strict cleanup",
      ]) {
        expect(run.stdout, marker).toContain(marker);
      }
    },
  );
});
