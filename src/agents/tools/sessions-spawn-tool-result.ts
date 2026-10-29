import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  mergeAcceptedSessionSpawnsForRun,
  normalizeAcceptedSessionSpawnResult,
} from "../accepted-session-spawn.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import type { captureProgressWorkWait } from "./progress-work-wait.js";
import { recordSessionToolActionFact } from "./sessions-helpers.js";

export async function recordAcceptedSessionSpawn(
  result: Record<string, unknown>,
  context: "fork" | "isolated" | undefined,
  retainWait: ReturnType<typeof captureProgressWorkWait>,
): Promise<void> {
  const instance = getGatewayToolCallerIdentity()?.operationalRunInstance;
  const accepted = normalizeAcceptedSessionSpawnResult({ details: result });
  if (instance && accepted) {
    mergeAcceptedSessionSpawnsForRun(instance, [accepted]);
    await retainWait?.({
      kind: "child",
      runId: accepted.runId,
      childSessionKey: accepted.childSessionKey,
    });
  }
  const childSessionKey =
    typeof result.childSessionKey === "string" ? result.childSessionKey.trim() : "";
  const targetAgentId = childSessionKey
    ? parseAgentSessionKey(childSessionKey)?.agentId
    : undefined;
  if (result.status !== "accepted" || !childSessionKey || !targetAgentId || !context) {
    return;
  }
  recordSessionToolActionFact({
    operation: context === "fork" ? "fork" : "create",
    fact: "committed",
    targetAgentId,
    targetSessionKey: childSessionKey,
  });
}
