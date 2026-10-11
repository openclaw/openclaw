import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { ClawAutomationMutationRequest } from "./automation-mutation-contract.js";
import type { ClawCronGateway } from "./cron.js";
import { digestClawValue } from "./digest.js";
import { readPortableHeartbeatState } from "./portable-heartbeat-state.js";
import { portableHeartbeatStateDigest } from "./portable-heartbeat-state.kernel.js";
import type { PortableHeartbeatState } from "./portable-heartbeat-state.types.js";
import { ClawPortableMutationUncertainError } from "./portable-heartbeat-write.js";
import type { PortableHeartbeatMutationResult } from "./portable-heartbeat-write.types.js";
import { readClawInstallRecord } from "./provenance.js";

/** A serving Gateway commits; the local reader only reconciles its acknowledged result. */
export async function mutatePortableHeartbeatViaGateway(
  agentId: string,
  config: OpenClawConfig,
  expected: PortableHeartbeatState,
  mutation: ClawAutomationMutationRequest["mutation"],
  options: OpenClawStateDatabaseOptions & {
    cronGateway: Pick<ClawCronGateway, "mutateAutomation" | "waitUntilAgentAvailable">;
    signal?: AbortSignal;
  },
): Promise<PortableHeartbeatMutationResult> {
  const gateway = options.cronGateway;
  if (!gateway.mutateAutomation) {
    throw new Error(
      "Portable automation changes require the Gateway claws.automations.mutate API.",
    );
  }
  if (mutation.kind !== "remove") {
    await gateway.waitUntilAgentAvailable?.(agentId);
  }
  const result = await gateway.mutateAutomation(
    {
      agentId,
      expectedStateDigest: portableHeartbeatStateDigest(expected),
      mutation,
    },
    { signal: options.signal },
  );
  try {
    const state = await readPortableHeartbeatState(agentId, config, options);
    if (portableHeartbeatStateDigest(state) !== result.stateDigest) {
      throw new Error("Committed portable automation changed before local reconciliation.");
    }
    const installRecord = result.installDigest
      ? readClawInstallRecord(agentId, options)
      : undefined;
    if (result.installDigest && digestClawValue(installRecord) !== result.installDigest) {
      throw new Error("Committed Claw install changed before local reconciliation.");
    }
    return { state, ...(installRecord ? { installRecord } : {}) };
  } catch (error) {
    throw new ClawPortableMutationUncertainError(error);
  }
}
