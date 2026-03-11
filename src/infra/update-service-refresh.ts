import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { pathExists } from "../utils.js";
import { resolveStableNodePath } from "./stable-node-path.js";

const DEFAULT_SERVICE_REFRESH_TIMEOUT_MS = 60_000;

export function resolveGatewayInstallEntrypointCandidates(root?: string): string[] {
  if (!root) {
    return [];
  }
  return [
    path.join(root, "openclaw.mjs"),
    path.join(root, "dist", "entry.js"),
    path.join(root, "dist", "entry.mjs"),
    path.join(root, "dist", "index.js"),
    path.join(root, "dist", "index.mjs"),
  ];
}

function formatCommandFailure(stdout: string, stderr: string): string {
  const detail = (stderr || stdout).trim();
  if (!detail) {
    return "command returned a non-zero exit code";
  }
  return detail.split("\n").slice(-3).join("\n");
}

export async function refreshGatewayServiceEnvFromUpdatedInstall(params: {
  root?: string;
  json?: boolean;
  timeoutMs?: number;
  fallback?: () => Promise<void>;
}): Promise<void> {
  const args = ["gateway", "install", "--force"];
  if (params.json) {
    args.push("--json");
  }

  for (const candidate of resolveGatewayInstallEntrypointCandidates(params.root)) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    const nodePath = await resolveStableNodePath(process.execPath);
    const res = await runCommandWithTimeout([nodePath, candidate, ...args], {
      timeoutMs: params.timeoutMs ?? DEFAULT_SERVICE_REFRESH_TIMEOUT_MS,
    });
    if (res.code === 0) {
      return;
    }
    throw new Error(
      `updated install refresh failed (${candidate}): ${formatCommandFailure(res.stdout, res.stderr)}`,
    );
  }

  if (params.fallback) {
    await params.fallback();
    return;
  }

  throw new Error("no updated gateway install entrypoint found");
}
