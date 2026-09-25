/**
 * Subagent spawn ownership resolver.
 *
 * Resolves which session controls spawn state, thread binding, and completion delivery.
 */
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../tools/sessions-helpers.js";

/** Normalizes requester/completion owner aliases into internal and display session keys. */
export function resolveSubagentSpawnOwnership(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  completionOwnerKey?: string;
}) {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const controllerSessionKey = params.agentSessionKey
    ? resolveInternalSessionKey({
        key: params.agentSessionKey,
        alias,
        mainKey,
      })
    : alias;
  const completionOwnerKey = params.completionOwnerKey?.trim();
  const completionRequesterSessionKey = completionOwnerKey
    ? resolveInternalSessionKey({
        key: completionOwnerKey,
        alias,
        mainKey,
      })
    : controllerSessionKey;
  // Completion ownership can differ from control ownership when a parent proxies the spawn.
  const completionRequesterDisplayKey = resolveDisplaySessionKey({
    key: completionRequesterSessionKey,
    alias,
    mainKey,
  });

  return {
    controllerSessionKey,
    completionRequesterSessionKey,
    completionRequesterDisplayKey,
  };
}

/** Retain saved requester ancestry only through the creation that transfers its policy. */
export async function withSubagentSpawnRequesterPolicy<T>(params: {
  cfg: OpenClawConfig;
  controllerSessionKey: string;
  completionRequesterSessionKey: string;
  requesterAgentId: string;
  assertCurrent: () => void;
  create: (assertCurrent: () => void) => Promise<T>;
}): Promise<T> {
  params.assertCurrent();
  if (params.controllerSessionKey === params.completionRequesterSessionKey) {
    return params.create(params.assertCurrent);
  }
  const {
    isSubagentEnvelopeSession,
    requiresSubagentCapabilityStore,
    resolvePersistedSubagentToolPolicyEnvelope,
  } = await import("./subagent-capabilities.js");
  params.assertCurrent();
  if (!requiresSubagentCapabilityStore(params.controllerSessionKey)) {
    return params.create(params.assertCurrent);
  }
  const { withSessionEntryReadOnlyInWorker } =
    await import("../../../config/sessions/session-entry-read-runtime.js");
  const { withPreparedSubagentCapabilityStore } =
    await import("./subagent-capability-preparation.js");
  const { resolveOriginalRequesterPolicyEnvelope } = await import("../../requester-tool-policy.js");
  params.assertCurrent();
  return withSessionEntryReadOnlyInWorker(
    {
      sessionKey: params.controllerSessionKey,
      agentId: params.requesterAgentId,
      storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
        agentId: params.requesterAgentId,
      }),
    },
    params.assertCurrent,
    async (read, assertReadCurrent) => {
      if (!read.ok) {
        throw read.error;
      }
      if (!read.value) {
        throw new Error("The proxy spawn requester is unavailable.");
      }
      return withPreparedSubagentCapabilityStore({
        cfg: params.cfg,
        preparedSessionEntry: {
          sessionKey: params.controllerSessionKey,
          agentId: params.requesterAgentId,
          entry: read.value,
        },
        assertCurrent: assertReadCurrent,
        consume: async ({ store, assertCurrent }) => {
          const controllerEnvelope = resolvePersistedSubagentToolPolicyEnvelope(
            params.controllerSessionKey,
            { cfg: params.cfg, store },
          );
          if (
            (controllerEnvelope ||
              isSubagentEnvelopeSession(params.controllerSessionKey, {
                cfg: params.cfg,
                store,
                entry: read.value,
              })) &&
            !resolveOriginalRequesterPolicyEnvelope({
              config: params.cfg,
              sourceSessionKey: params.controllerSessionKey,
              targetSessionKey: params.completionRequesterSessionKey,
              store,
            })
          ) {
            throw new Error(
              "Delegated completion requires the original requester in the source ancestry.",
            );
          }
          return params.create(() => {
            params.assertCurrent();
            assertCurrent();
          });
        },
      });
    },
  );
}
