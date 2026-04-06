import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makePathEnv, makeTempDir } from "../exec-approvals-test-helpers.js";
import { evaluateShellAllowlist, normalizeSafeBins } from "../exec-approvals.js";

describe.runIf(process.platform !== "win32")("Clay command contract", () => {
  function makeExecutable(dir: string, name: string): string {
    const exe = path.join(dir, name);
    fs.writeFileSync(exe, "");
    fs.chmodSync(exe, 0o755);
    return exe;
  }

  it("uses explicit executable/script paths instead of general-purpose safe bins", () => {
    const dir = makeTempDir();
    const blender = makeExecutable(dir, "blender");
    makeExecutable(dir, "python3");
    const scriptsDir = path.join(dir, "asset-pipeline");
    fs.mkdirSync(scriptsDir, { recursive: true });
    const exportScript = path.join(scriptsDir, "export_asset.py");
    const bakeScript = path.join(scriptsDir, "bake_materials.py");
    fs.writeFileSync(exportScript, "print('export')\n");
    fs.writeFileSync(bakeScript, "print('bake')\n");

    const clayContract = {
      safeBins: normalizeSafeBins([]),
      allowlist: [{ pattern: blender }, { pattern: exportScript }, { pattern: bakeScript }],
    };

    for (const bin of ["python3", "bash", "rm", "cp", "mv", "mkdir"]) {
      expect(clayContract.safeBins.has(bin)).toBe(false);
    }

    const env = makePathEnv(dir);

    expect(
      evaluateShellAllowlist({
        command: `blender --background scene.blend --python ${exportScript} -- --out /tmp/out.glb`,
        allowlist: clayContract.allowlist,
        safeBins: clayContract.safeBins,
        cwd: dir,
        env,
        platform: process.platform,
      }).allowlistSatisfied,
    ).toBe(true);

    expect(
      evaluateShellAllowlist({
        command: `python3 ${bakeScript} --material oak`,
        allowlist: clayContract.allowlist,
        safeBins: clayContract.safeBins,
        cwd: dir,
        env,
        platform: process.platform,
      }).allowlistSatisfied,
    ).toBe(true);

    expect(
      evaluateShellAllowlist({
        command: "python3 /tmp/unvetted.py --material oak",
        allowlist: clayContract.allowlist,
        safeBins: clayContract.safeBins,
        cwd: dir,
        env,
        platform: process.platform,
      }).allowlistSatisfied,
    ).toBe(false);
  });
});
