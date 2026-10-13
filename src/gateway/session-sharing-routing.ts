import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SessionMutationFactsUnavailableError } from "./session-sharing-incognito.js";
import { readSessionRoutingFacts, type SessionRoutingTarget } from "./session-store-key.js";

export function captureSessionMutationRouting(
  cfg: OpenClawConfig,
  changed: () => Error = () => new SessionMutationFactsUnavailableError(),
  targets?: readonly SessionRoutingTarget[],
) {
  const capturedTargets = targets?.length
    ? targets.map(({ sessionKey, agentId, preserveQualifiedAddress }) => ({
        sessionKey,
        agentId,
        preserveQualifiedAddress,
      }))
    : undefined;
  const route = readSessionRoutingFacts(cfg, capturedTargets);
  return (current: OpenClawConfig) => {
    if (!isDeepStrictEqual(readSessionRoutingFacts(current, capturedTargets), route)) {
      throw changed();
    }
  };
}
