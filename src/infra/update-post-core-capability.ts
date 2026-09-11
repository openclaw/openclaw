import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";

const POST_CORE_EXECUTOR_CAPABILITY = "fd3-pid-start-v1";

/** Compatibility only: authority still comes from the original live executor. */
export async function supportsPostCoreExecutor(root: string, nodeRunner: string): Promise<boolean> {
  const entry = await resolveGatewayInstallEntrypoint(root);
  // entry.js can respawn; it cannot carry this private descriptor to the bound PID.
  if (!entry || !["index.js", "index.mjs"].includes(path.basename(entry))) {
    return false;
  }
  const check = await runUtf8CommandWithTimeout(
    [
      nodeRunner,
      path.join(root, "dist", runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath),
      "--check",
    ],
    {
      cwd: root,
      baseEnv: {},
      timeoutMs: 30_000,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      killGraceMs: 500,
      maxOutputBytes: 64 * 1024,
    },
  );
  if (check.termination !== "exit" || check.code !== 0 || check.cleanup !== "normal") {
    return false;
  }
  try {
    const contract: unknown = JSON.parse(check.stdout);
    return isRecord(contract) && contract.postCoreExecutor === POST_CORE_EXECUTOR_CAPABILITY;
  } catch {
    return false;
  }
}
