import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readAcpSessionMetaForEntries } from "../../acp/runtime/session-meta-readonly.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { resolveConversationToolPolicies } from "../../agents/conversation-tool-policy-pipeline.js";
import { prepareDelegatedToolParameterTarget } from "../../agents/delegated-tool-parameter-target.js";
import { resolveAcpInheritedToolPolicyError } from "../../agents/inherited-tool-deny.js";
import { captureDelegatedToolParameters } from "../../agents/inherited-tool-parameters.js";
import {
  assertInheritedToolPolicyCompatible,
  captureInheritedToolPolicy,
} from "../../agents/inherited-tool-policy.js";
import type { InheritedToolPolicyV2 } from "../../agents/inherited-tool-policy.schema.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolvePersistedSubagentToolPolicyEnvelope } from "../../agents/subagents/spawn/subagent-capabilities.js";
import { withPreparedSubagentCapabilityStore } from "../../agents/subagents/spawn/subagent-capability-preparation.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import type { AgentTurnContext } from "./types.js";

const policyFields = [
  "sessionId",
  "lifecycleRevision",
  "spawnDepth",
  "subagentRole",
  "subagentControlScope",
  "spawnedBy",
  "completionOwnerSessionKey",
  "inheritedToolPolicyVersion",
  "inheritedToolPolicy",
  "inheritedToolAllow",
  "inheritedToolDeny",
  "permissionMode",
  "sessionRoot",
  "sandbox",
  "sandboxMode",
  "createdActor",
  "execHost",
  "execNode",
  "execCwd",
  "modelOverride",
  "providerOverride",
  "model",
  "modelProvider",
  "agentRuntimeOverride",
] as const satisfies readonly (keyof SessionEntry)[];

function policyFacts(entry: SessionEntry | undefined) {
  return entry ? Object.fromEntries(policyFields.map((key) => [key, entry[key]])) : undefined;
}

/** Prospective runtime admission; actual execution revalidates consumption. */
export async function withCompatibleSessionSendTarget<T>(params: {
  config: OpenClawConfig;
  context: AgentTurnContext;
  agentId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  storePath: string;
  workspaceDir: string;
  modelProvider: string;
  modelId: string;
  source: InheritedToolPolicyV2;
  assertCurrent: () => void;
  consume: (assertCurrent: () => void) => Promise<T>;
}): Promise<T> {
  return withPreparedSubagentCapabilityStore({
    cfg: params.config,
    preparedSessionEntry: {
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      entry: params.sessionEntry,
    },
    storePath: params.storePath,
    assertCurrent: params.assertCurrent,
    consume: async ({ store, assertCurrent, sessionScopes, readEntry }) => {
      const projection = getSessionRowProjection(params.context);
      if (!projection) {
        throw new Error(
          "Delegated input policy is unavailable while session authority is preparing.",
        );
      }
      await projection.prepareMembership();
      assertCurrent();
      const config = projection.getPolicyConfig();
      const targets = sessionScopes.map(({ sessionKey: key, agentId, storePath }) => {
        const query = { agentId, key, storePath };
        const state = projection.sharingTargetState(query);
        const entry = readEntry(key);
        if (
          state.status !== "ready" ||
          !isDeepStrictEqual(policyFacts(state.target.entry), policyFacts(entry))
        ) {
          throw new Error(
            "Delegated input target policy changed during preparation; retry the send.",
          );
        }
        return { query, target: state.target, facts: structuredClone(policyFacts(entry)) };
      });
      let acpBindingUncertain = false;
      const stopObserving = sessionChanges.subscribeFacts((change) => {
        // ACP publishes metadata separately from session-row facts. Its absence
        // cannot be reused after an unqualified target metadata publication.
        if (
          !("all" in change) &&
          change.sessionKey === params.sessionKey &&
          (!change.agentId || change.agentId === params.agentId) &&
          !change.scope &&
          !change.facts &&
          !change.factsInvalidated
        ) {
          acpBindingUncertain = true;
        }
      });
      const assertTargetCurrent = () => {
        assertCurrent();
        if (
          acpBindingUncertain ||
          getSessionRowProjection(params.context) !== projection ||
          projection.getPolicyConfig() !== config
        ) {
          throw new Error(
            "Delegated input target authority changed during preparation; retry the send.",
          );
        }
        for (const { query, target, facts } of targets) {
          const state = projection.sharingTargetState(query);
          if (
            state.status !== "ready" ||
            state.target.generation !== target.generation ||
            state.target.storePath !== target.storePath ||
            !isDeepStrictEqual(policyFacts(state.target.entry), facts)
          ) {
            throw new Error(
              "Delegated input target policy changed during preparation; retry the send.",
            );
          }
        }
      };
      try {
        const [acp] = params.sessionEntry
          ? await readAcpSessionMetaForEntries({
              cfg: params.config,
              entries: [
                {
                  sessionKey: params.sessionKey,
                  agentId: params.agentId,
                  entry: params.sessionEntry,
                },
              ],
            })
          : [];
        assertCurrent();
        if (acp) {
          const inherited = resolvePersistedSubagentToolPolicyEnvelope(params.sessionKey, {
            cfg: params.config,
            store,
          });
          for (const policy of [
            params.source,
            inherited?.version === 2 ? inherited.policy : undefined,
          ]) {
            const error = policy ? resolveAcpInheritedToolPolicyError(policy) : undefined;
            if (error) {
              throw new Error(error);
            }
          }
          assertTargetCurrent();
          return await params.consume(assertTargetCurrent);
        }
        const sandbox = resolveSandboxRuntimeStatus({
          cfg: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          preparedSessionEntry: params.sessionEntry ?? null,
        });
        const metadata = getGatewayPluginMetadataSnapshot();
        const profile = resolveConversationCapabilityProfile({
          config: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionEntry?.sessionId,
          preparedSessionEntry: params.sessionEntry
            ? { sessionKey: params.sessionKey, entry: params.sessionEntry }
            : undefined,
          preparedSessionCapabilityStore: store,
          spawnedBy: params.sessionEntry?.spawnedBy,
          modelProvider: params.modelProvider,
          modelId: params.modelId,
          workspaceDir: params.workspaceDir,
          pluginMetadataSnapshot: metadata,
          // The preaccept upper bound omits ingress sender/group restrictions.
          // It must never infer a narrower policy from an unavailable identity.
          messageProvider: INTERNAL_MESSAGE_CHANNEL,
          senderIsOwner: true,
          sandboxToolPolicy: sandbox.sandboxed ? sandbox.toolPolicy : undefined,
        });
        const root = params.sessionEntry?.sessionRoot ?? params.workspaceDir;
        const parameterFacts = prepareDelegatedToolParameterTarget({
          config: params.config,
          agentId: params.agentId,
          sessionEntry: params.sessionEntry ?? null,
          sessionPermissionPolicy: params.sessionEntry?.permissionMode
            ? { root, mode: params.sessionEntry.permissionMode }
            : undefined,
          rootIsWorkspace: path.resolve(root) === path.resolve(params.workspaceDir),
          // sessions_send agent ingress has no exec-approval continuation handoff.
          elevated: null,
          sandbox,
          modelProvider: params.modelProvider,
          modelId: params.modelId,
        });
        const target = captureInheritedToolPolicy({
          policies: Object.values(resolveConversationToolPolicies({ capabilityProfile: profile })),
          inherited: profile.policy.inheritedActionPolicy,
          parameters: captureDelegatedToolParameters(parameterFacts),
        });
        assertTargetCurrent();
        assertInheritedToolPolicyCompatible({
          source: params.source,
          target,
          targetEnforcedParameters: profile.policy.inheritedActionPolicy?.parameters,
        });
        return await params.consume(assertTargetCurrent);
      } finally {
        stopObserving();
      }
    },
  });
}
