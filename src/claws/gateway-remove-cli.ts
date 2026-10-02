import { resolveCurrentOpenClawCliInvocation } from "../infra/openclaw-cli-invocation.js";
import { runCommandBuffered } from "../process/exec.js";

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const REMOVE_APPLY_KILL_GRACE_MS = 5_000;

export type ClawRemoveCliResponse = {
  code: number;
  payload: unknown;
};

export async function runClawRemoveCli(input: {
  agentId: string;
  planIntegrity?: string;
  signal?: AbortSignal;
}): Promise<ClawRemoveCliResponse> {
  const invocation = resolveCurrentOpenClawCliInvocation(
    [
      "claws",
      "remove",
      input.agentId,
      "--exact-agent-id",
      ...(input.planIntegrity ? ["--yes", "--plan-integrity", input.planIntegrity] : ["--dry-run"]),
      "--json",
    ],
    { moduleUrl: import.meta.url },
  );
  const result = await runCommandBuffered([invocation.command, ...invocation.args], {
    cwd: invocation.cwd,
    ...(invocation.env ? { env: invocation.env } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    timeoutMs: input.planIntegrity ? 600_000 : 90_000,
    ...(input.planIntegrity ? { killGraceMs: REMOVE_APPLY_KILL_GRACE_MS } : {}),
    maxOutputBytes: { stdout: MAX_STDOUT_BYTES, stderr: MAX_STDERR_BYTES },
    maxCombinedOutputBytes: MAX_STDOUT_BYTES + MAX_STDERR_BYTES,
    killProcessTree: true,
  });
  if (result.termination !== "exit" || result.code === null) {
    throw new Error("The Claw removal command did not complete.");
  }
  try {
    return { code: result.code, payload: JSON.parse(result.stdout.toString("utf8")) as unknown };
  } catch {
    throw new Error("The Claw removal command returned an invalid result.");
  }
}
