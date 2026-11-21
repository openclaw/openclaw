import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
import { readPackageVersion } from "../infra/package-json.js";
import { readBuiltGatewayBuildId } from "../infra/update-git-runtime.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { PrepareResult } from "./prepare-git.js";

export async function preparePackage(params: {
  spec: string;
  staging: string;
  npm: string;
  node: string;
  timeoutMs: number;
  onStep?: (name: string) => void | Promise<void>;
}): Promise<PrepareResult> {
  const releaseRoot = path.join(
    params.staging,
    ...(process.platform === "win32" ? [] : ["lib"]),
    "node_modules",
    "openclaw",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.dirname(params.node)}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  // The old updater's marker makes Windows postinstall enter its migration path.
  delete env.OPENCLAW_UPDATE_IN_PROGRESS;
  try {
    await fs.mkdir(params.staging, { recursive: true });
    await params.onStep?.("install");
    const result = await runCommandWithTimeout(
      [
        params.npm,
        "install",
        "-g",
        "--prefix",
        params.staging,
        params.spec,
        "--no-fund",
        "--no-audit",
        "--ignore-scripts=false",
      ],
      { baseEnv: env, timeoutMs: params.timeoutMs, killProcessTree: true },
    );
    if (result.code !== 0 || result.killed || result.signal) {
      throw new Error(result.stderr || result.stdout || `npm exited ${result.code}`);
    }
    const version = await readPackageVersion(releaseRoot);
    if (!version) {
      throw new Error("Prepared package has no package version.");
    }
    const buildId = await readBuiltGatewayBuildId(releaseRoot);
    return { ok: true, releaseRoot, version, ...(buildId ? { buildId } : {}) };
  } catch (error) {
    await fs.rm(params.staging, { recursive: true, force: true });
    return {
      ok: false,
      reason: "package-install-failed",
      stderrTail: formatErrorMessage(error).slice(-8192),
    };
  }
}
