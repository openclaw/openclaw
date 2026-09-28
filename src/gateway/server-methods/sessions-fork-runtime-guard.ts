import { isDeepStrictEqual } from "node:util";
import { listRegisteredAgentHarnesses } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import {
  readSessionUpstreamLink,
  type SessionUpstreamLink,
} from "../../sessions/session-upstream-links.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { resolveSessionNativeRuntimeRestriction } from "./sessions-patch-model-selection.js";
import { loadAccessorSessionEntryForGatewayTarget } from "./sessions-shared.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export type UpstreamForkHarness = {
  harness: AgentHarness;
} & (
  | {
      contract: "legacy";
      sessionFork: NonNullable<AgentHarness["sessionFork"]>;
    }
  | {
      contract: "v2";
      sessionFork: NonNullable<AgentHarness["sessionForkV2"]>;
    }
);

export type UpstreamForkCurrentGuard = {
  assertCurrent: () => void;
  assertRollbackCurrent: () => void;
};

export function resolveUpstreamForkHarness(
  link: SessionUpstreamLink,
): UpstreamForkHarness | undefined {
  const matches: UpstreamForkHarness[] = [];
  for (const { harness } of listRegisteredAgentHarnesses()) {
    // Dual registration lets one plugin serve old and current hosts; V2 owns this host.
    if (harness.sessionForkV2?.upstreamKinds.includes(link.upstreamKind)) {
      matches.push({ harness, contract: "v2", sessionFork: harness.sessionForkV2 });
    } else if (harness.sessionFork?.upstreamKinds.includes(link.upstreamKind)) {
      matches.push({ harness, contract: "legacy", sessionFork: harness.sessionFork });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** Keep the source incarnation, creator ceiling, and fork execution policy current until native I/O. */
export function createUpstreamForkCurrentGuard(params: {
  client: GatewayClient | null;
  commitGuard: () => void;
  context: Pick<GatewayRequestContext, "getRuntimeConfig">;
  forkHarness: UpstreamForkHarness;
  link: SessionUpstreamLink;
  requestedAgentId: string;
  sessionKey: string;
  source: ReturnType<typeof loadAccessorSessionEntryForGatewayTarget>;
  targetKey: string;
}): UpstreamForkCurrentGuard {
  const expectedEntry = params.source.entry;
  if (!expectedEntry) {
    throw new Error(`Session ${params.sessionKey} changed during fork initialization`);
  }
  const readCurrent = () => {
    params.commitGuard();
    const currentConfig = params.context.getRuntimeConfig();
    const source = loadAccessorSessionEntryForGatewayTarget({
      key: params.sessionKey,
      cfg: currentConfig,
      agentId: params.requestedAgentId,
    });
    const sourceEntry = source.entry;
    const currentLink = sourceEntry
      ? readSessionUpstreamLink(source.canonicalKey, source.target.agentId)
      : undefined;
    const currentForkHarness = currentLink ? resolveUpstreamForkHarness(currentLink) : undefined;
    if (
      !sourceEntry ||
      sourceEntry.sessionId !== expectedEntry.sessionId ||
      sourceEntry.lifecycleRevision !== expectedEntry.lifecycleRevision ||
      sourceEntry.initializationPending === true ||
      source.target.agentId !== params.source.target.agentId ||
      source.canonicalKey !== params.source.canonicalKey ||
      source.storePath !== params.source.storePath ||
      !currentLink ||
      currentLink.catalogId !== params.link.catalogId ||
      currentLink.hostId !== params.link.hostId ||
      currentLink.threadId !== params.link.threadId ||
      currentLink.upstreamKind !== params.link.upstreamKind ||
      !isDeepStrictEqual(currentLink.upstreamRef, params.link.upstreamRef) ||
      !currentForkHarness ||
      currentForkHarness.harness !== params.forkHarness.harness ||
      currentForkHarness.contract !== params.forkHarness.contract ||
      currentForkHarness.sessionFork !== params.forkHarness.sessionFork
    ) {
      throw new Error(`Session ${params.sessionKey} changed during fork initialization`);
    }
    const creationError = authorizeGatewaySessionCreation({
      cfg: currentConfig,
      client: params.client,
      agentId: source.target.agentId,
    });
    if (creationError) {
      throw new SessionMutationAuthorizationChangedError(creationError);
    }
    return { currentConfig, currentForkHarness, source, sourceEntry };
  };
  const assertCurrent = () => {
    const { currentConfig, currentForkHarness, source, sourceEntry } = readCurrent();
    const executionEnvironment =
      currentForkHarness.contract === "v2"
        ? (currentForkHarness.sessionFork.executionEnvironment ??
          currentForkHarness.harness.executionEnvironment)
        : currentForkHarness.harness.executionEnvironment;
    if (executionEnvironment !== "host-only") {
      return;
    }
    const currentSandbox =
      sourceEntry.sandbox === "required" ||
      resolveCreatorSandbox(currentConfig, resolveOperatorSessionCreation(params.client)) ===
        "required"
        ? "required"
        : undefined;
    const sourceModel = resolveSessionModelRef(currentConfig, sourceEntry, source.target.agentId);
    const policyHarness =
      currentForkHarness.harness.executionEnvironment === "host-only"
        ? currentForkHarness.harness
        : { ...currentForkHarness.harness, executionEnvironment };
    const restriction = resolveSessionNativeRuntimeRestriction({
      operation: "fork",
      cfg: currentConfig,
      agentId: source.target.agentId,
      sessionKey: params.targetKey,
      entry: currentSandbox === "required" ? { sandbox: "required" } : {},
      persistedEntry: undefined,
      harness: policyHarness,
      provider: sourceModel.provider,
      modelId: sourceModel.model,
      callerCanConsent: false,
    });
    if (restriction) {
      throw new SessionMutationAuthorizationChangedError(restriction);
    }
  };
  return {
    assertCurrent,
    // After capture, the child initializer and plugin own rollback independently;
    // their target, registry, binding, and thread fences replace forward authority.
    assertRollbackCurrent: () => undefined,
  };
}
