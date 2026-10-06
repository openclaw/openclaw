import type { SessionsDiffResult } from "../../packages/gateway-protocol/src/index.js";
import type { SessionDiffBaseline } from "../config/sessions/types.js";
import { runGitReadOperation } from "../infra/git-read-cache.js";
import type { GitCheckoutDiffInput } from "../infra/git-read-operations.js";

export async function loadCheckoutDiff(
  params: GitCheckoutDiffInput & { sessionKey: string },
): Promise<SessionsDiffResult> {
  const { sessionKey, ...input } = params;
  const diff = await runGitReadOperation({ type: "checkout.diff", input });
  return { ...diff, sessionKey };
}

export async function captureSessionDiffBaseline(params: {
  cwd: string;
  sessionId: string;
}): Promise<SessionDiffBaseline | undefined> {
  const baseline = await runGitReadOperation({
    type: "checkout.baseline",
    input: { cwd: params.cwd },
  });
  return baseline ? { ...baseline, sessionId: params.sessionId } : undefined;
}
