import { listRegisteredAgentHarnesses } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import {
  readCurrentSessionUpstreamLink,
  type SessionUpstreamLinkReadSource,
} from "../../sessions/session-upstream-links-runtime.js";
import type { SessionUpstreamLink } from "../../sessions/session-upstream-links.js";
import { sessionUpstreamLinkSourceMatches } from "../../sessions/session-upstream-links.kernel.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { loadGatewaySessionEntry } from "../session-utils-store.js";
import { resolveSessionNativeRuntimeRestriction } from "./sessions-patch-model-selection.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type UpstreamForkHarness = {
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
  source: ReturnType<typeof loadGatewaySessionEntry>;
  targetKey: string;
  upstreamContext: SessionUpstreamLinkReadSource;
}) {
  const expectedEntry = params.source.entry;
  if (!expectedEntry) {
    throw new Error(`Session ${params.sessionKey} changed during fork initialization`);
  }
  const upstreamSource = params.upstreamContext;
  const { context } = upstreamSource;
  const expectedLink = structuredClone(params.link);
  const sourceMetadata = captureSessionEntryMetadataRead({
    agentId: params.source.agentId,
    sessionKey: params.source.canonicalKey,
    storePath: params.source.storePath,
  });
  let inSourceTransaction = false;
  const readCurrent = () => {
    upstreamSource.assertCurrent();
    params.commitGuard();
    const currentConfig = params.context.getRuntimeConfig();
    const source = sourceMetadata
      ? params.source
      : loadGatewaySessionEntry(
          params.sessionKey,
          { agentId: params.requestedAgentId },
          currentConfig,
        );
    const sourceEntry = sourceMetadata ? sourceMetadata.readCurrent() : source.entry;
    if (sourceMetadata) {
      const selected = resolveSessionStoreIdentity({
        cfg: currentConfig,
        sessionKey: params.sessionKey,
        agentId: params.requestedAgentId,
      });
      if (selected.agentId !== source.agentId || selected.canonicalKey !== source.canonicalKey) {
        throw new Error(`Session ${params.sessionKey} changed during fork initialization`);
      }
    }
    const currentLink = sourceEntry
      ? inSourceTransaction
        ? expectedLink
        : readCurrentSessionUpstreamLink(upstreamSource, source.canonicalKey, source.agentId)
      : undefined;
    const currentForkHarness = currentLink ? resolveUpstreamForkHarness(currentLink) : undefined;
    if (
      !sourceEntry ||
      sourceEntry.sessionId !== expectedEntry.sessionId ||
      sourceEntry.lifecycleRevision !== expectedEntry.lifecycleRevision ||
      sourceEntry.initializationPending === true ||
      source.agentId !== params.source.agentId ||
      source.canonicalKey !== params.source.canonicalKey ||
      source.storePath !== params.source.storePath ||
      !sessionUpstreamLinkSourceMatches(currentLink, expectedLink) ||
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
      agentId: source.agentId,
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
    const sourceModel = resolveSessionModelRef(currentConfig, sourceEntry, source.agentId);
    const policyHarness =
      currentForkHarness.harness.executionEnvironment === "host-only"
        ? currentForkHarness.harness
        : { ...currentForkHarness.harness, executionEnvironment };
    const restriction = resolveSessionNativeRuntimeRestriction({
      operation: "fork",
      cfg: currentConfig,
      agentId: source.agentId,
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
    upstreamLinkCurrent: {
      context,
      expected: expectedLink,
      withCurrent<T>(run: () => T): T {
        // The shared writer has checked this exact source inside its transaction.
        const previous = inSourceTransaction;
        inSourceTransaction = true;
        try {
          return run();
        } finally {
          inSourceTransaction = previous;
        }
      },
    },
    assertCurrent,
    // After capture, the child initializer and plugin own rollback independently;
    // their target, registry, binding, and thread fences replace forward authority.
    assertRollbackCurrent: () => undefined,
  };
}
