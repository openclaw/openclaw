import { isDeepStrictEqual } from "node:util";
import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
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
  let publication = runtimeConfigPublication.current;
  if (publication?.config !== cfg) {
    publication = undefined;
  }
  return (current: OpenClawConfig) => {
    const next = runtimeConfigPublication.current;
    // The config owner advances this revision before publishing same-object edits.
    if (next && next.config === current && next.revision === publication?.revision) {
      return;
    }
    if (!isDeepStrictEqual(readSessionRoutingFacts(current, capturedTargets), route)) {
      throw changed();
    }
    publication = next?.config === current ? next : undefined;
  };
}
