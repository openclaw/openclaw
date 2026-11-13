import {
  ErrorCodes,
  errorShape,
  type SessionVisibility,
} from "../../../packages/gateway-protocol/src/index.js";
import { listRegisteredAgentHarnesses } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { prepareSessionCapabilityRead } from "../../agents/subagents/spawn/subagent-session-store.js";
import { readRetainedSessionEntryFacts } from "../../config/sessions/session-entry-read-facts.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { SessionUpstreamLink } from "../../sessions/session-upstream-links.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { resolveSessionCreateVisibility } from "../session-create-visibility.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import type { GatewaySessionEntryRead } from "../session-utils-store.js";
import { resolveSessionNativeRuntimeRestriction } from "./sessions-patch-model-selection.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export const EXTERNAL_CONVERSATION_ERROR =
  "Session history changes are unavailable because this session is owned by an external agent harness.";

export function createLocalMessageCutGuards(params: {
  action: "fork" | "rewind" | "switch";
  context: Pick<GatewayRequestContext, "getRuntimeConfig" | "getCommittedRuntimeConfig">;
  hasUpstream: () => boolean;
}) {
  const upstreamChanged = new SessionMutationAuthorizationChangedError(
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      params.action === "fork" ? "Session changed; retry fork." : EXTERNAL_CONVERSATION_ERROR,
    ),
  );
  const assertUpstreamCurrent = () => {
    if (params.hasUpstream()) {
      throw upstreamChanged;
    }
  };
  const assertForkVisibilityAllowed = (visibility: SessionVisibility | undefined) => {
    const selected = resolveSessionCreateVisibility(
      {
        cfg: params.context.getCommittedRuntimeConfig?.() ?? params.context.getRuntimeConfig(),
        visibility,
      },
      undefined,
    );
    if (!selected.ok) {
      throw new SessionMutationAuthorizationChangedError({
        ...selected.error,
        message:
          "Draft creation is disabled. Continue in this conversation, or ask an administrator to enable Drafts before forking.",
      });
    }
  };
  return { upstreamChanged, assertUpstreamCurrent, assertForkVisibilityAllowed };
}

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

/** Keep source identity and execution authority current until native I/O. */
export async function prepareUpstreamForkCurrentGuard(params: {
  client: GatewayClient | null;
  commitGuard: () => void;
  context: Pick<GatewayRequestContext, "getRuntimeConfig">;
  forkHarness: UpstreamForkHarness;
  requestedAgentId: string;
  sessionKey: string;
  source: GatewaySessionEntryRead;
  targetKey: string;
}) {
  const expectedEntry = params.source.entry;
  if (!expectedEntry) {
    throw new Error(`Session ${params.sessionKey} changed during fork initialization`);
  }
  const sourceMetadata = captureSessionEntryMetadataRead(
    {
      agentId: params.source.agentId,
      sessionKey: params.source.canonicalKey,
      storePath: params.source.storePath,
    },
    params.commitGuard,
  );
  const assertCurrent = () => {
    params.commitGuard();
    const currentConfig = params.context.getRuntimeConfig();
    const source = params.source;
    const sourceEntry = sourceMetadata
      ? sourceMetadata.readCurrent()
      : readRetainedSessionEntryFacts(
          {
            agentId: source.readSource?.agentId ?? source.agentId,
            path: source.readSource?.path ?? source.storePath,
          },
          { sessionKeys: [source.canonicalKey] },
        )?.entries.find((row) => row.sessionKey === source.canonicalKey)?.entry;
    if (
      !sourceEntry ||
      sourceEntry.sessionId !== expectedEntry.sessionId ||
      sourceEntry.lifecycleRevision !== expectedEntry.lifecycleRevision ||
      sourceEntry.initializationPending === true ||
      source.agentId !== params.source.agentId ||
      source.canonicalKey !== params.source.canonicalKey ||
      source.storePath !== params.source.storePath
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
    const currentForkHarness = params.forkHarness;
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
  const prepared = await prepareSessionCapabilityRead(assertCurrent);
  return {
    assertCurrent: prepared.read,
    release: prepared.release,
    // After capture, the child initializer and plugin own rollback independently;
    // their target, registry, binding, and thread fences replace forward authority.
    assertRollbackCurrent: () => undefined,
  };
}
