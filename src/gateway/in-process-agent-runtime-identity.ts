import { createPrivateContextCarrier } from "../shared/private-context-carrier.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";

const identities = createPrivateContextCarrier<AgentRuntimeIdentity>();

/** Carry authenticated runtime identity without widening plugin dispatch options. */
export const withInProcessAgentRuntimeIdentity = identities.carry;

export function readInProcessAgentRuntimeIdentity(
  options: object | undefined,
): AgentRuntimeIdentity | undefined {
  return options ? identities.read(options) : undefined;
}
