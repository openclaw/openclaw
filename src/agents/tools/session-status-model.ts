import { randomUUID } from "node:crypto";
import { patchSessionEntryWithKey, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasOperatorToolGatewayAuthority } from "../../gateway/operator-invocation-authority.js";
import { withSessionStatusModelPatchOrigin } from "../../gateway/session-model-patch-origin.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import type { SessionsPatchResult } from "../../gateway/session-utils.types.js";
import {
  isPluginMetadataSnapshotCompatible,
  resolvePluginMetadataSnapshot,
} from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { applyModelOverrideWithAuthProfileCompatibility } from "../../sessions/auth-profile-preservation.js";
import {
  buildModelAliasIndex,
  modelKey,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../model-selection.js";
import { createModelVisibilityPolicy } from "../model-visibility-policy.js";
import { loadPublishedPreparedModelCatalog } from "../prepared-model-catalog.js";
import { normalizeToolModelOverride, ToolAuthorizationError } from "./common.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import type { resolveSessionStatusEntry } from "./session-status-session-resolve.js";

type ResolvedStatusSession = NonNullable<ReturnType<typeof resolveSessionStatusEntry>>;

async function resolveModelOverride(params: {
  cfg: OpenClawConfig;
  raw: string;
  sessionEntry?: SessionEntry;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<
  | { kind: "reset" }
  | {
      kind: "set";
      provider: string;
      model: string;
      isDefault: boolean;
    }
> {
  const raw = normalizeToolModelOverride(params.raw);
  if (!raw) {
    return { kind: "reset" };
  }

  const configDefault = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const currentProvider = params.sessionEntry?.providerOverride?.trim() || configDefault.provider;

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: currentProvider,
  });
  const catalog = await loadPublishedPreparedModelCatalog({
    config: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    readOnly: true,
    ...(params.sessionEntry?.spawnedWorkspaceDir
      ? { workspaceDir: params.sessionEntry.spawnedWorkspaceDir }
      : {}),
  });
  const workspaceDir = params.sessionEntry?.spawnedWorkspaceDir ?? params.workspaceDir;
  const manifestMetadataSnapshot =
    params.metadataSnapshot &&
    params.metadataSnapshot.pluginIds === undefined &&
    isPluginMetadataSnapshotCompatible({
      snapshot: params.metadataSnapshot,
      config: params.cfg,
      env: process.env,
      workspaceDir,
    })
      ? params.metadataSnapshot
      : resolvePluginMetadataSnapshot({
          config: params.cfg,
          ...(workspaceDir ? { workspaceDir } : {}),
          env: process.env,
        });
  const modelManifestContext = {
    manifestPlugins: manifestMetadataSnapshot,
  };
  const policy = createModelVisibilityPolicy({
    cfg: params.cfg,
    catalog,
    defaultProvider: currentProvider,
    defaultModel: configDefault,
    agentId: params.agentId,
    allowManifestNormalization: true,
    allowPluginNormalization: true,
    ...modelManifestContext,
  });

  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    agentId: params.agentId,
    raw,
    defaultProvider: currentProvider,
    aliasIndex,
    allowManifestNormalization: true,
    allowPluginNormalization: true,
    ...modelManifestContext,
  });
  if (!resolved) {
    throw new Error(`Unrecognized model "${raw}".`);
  }
  const key = modelKey(resolved.ref.provider, resolved.ref.model);
  if (!policy.allows(resolved.ref)) {
    throw new Error(`Model "${key}" is not allowed.`);
  }
  const isDefault =
    resolved.ref.provider === configDefault.provider && resolved.ref.model === configDefault.model;
  return {
    kind: "set",
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    isDefault,
  };
}

/** Gateway requests use the mutation owner; standalone runs retain their local store contract. */
export async function patchSessionStatusModel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  storePath: string;
  raw: string;
  resolved: ResolvedStatusSession;
  metadataSnapshot?: PluginMetadataSnapshot;
  gatewayCall?: AgentToolGatewayRequestCaller;
}): Promise<{ resolved: ResolvedStatusSession; changedModel: boolean }> {
  const { cfg, agentId, resolved } = params;
  if (hasOperatorToolGatewayAuthority() && !params.gatewayCall) {
    throw new ToolAuthorizationError("Operator model selection requires a current Gateway.");
  }
  if (params.gatewayCall) {
    const gatewayCall = params.gatewayCall;
    const { result, applied } = await withSessionStatusModelPatchOrigin(() =>
      gatewayCall<SessionsPatchResult>({
        method: "sessions.patch",
        params: {
          key: resolved.key,
          agentId,
          ...(resolved.persisted
            ? {
                ...(resolved.entry.sessionId.trim()
                  ? { expectedSessionId: resolved.entry.sessionId }
                  : {}),
                expectedLifecycleRevision: resolved.entry.lifecycleRevision,
              }
            : {}),
          model: normalizeToolModelOverride(params.raw) ?? null,
        },
      }),
    );
    return {
      resolved: { key: result.key, entry: result.entry, persisted: true },
      changedModel: applied,
    };
  }

  const configured = resolveDefaultModelForAgent({ cfg, agentId });
  const selection = await resolveModelOverride({
    ...params,
    sessionEntry: resolved.entry,
  });
  const modelSelection =
    selection.kind === "reset" ? { ...configured, isDefault: true } : selection;
  const applied = applyModelOverrideWithAuthProfileCompatibility({
    cfg,
    agentDir: params.agentDir,
    entry: { ...resolved.entry },
    currentProvider:
      resolved.entry.providerOverride?.trim() ||
      resolved.entry.modelProvider?.trim() ||
      configured.provider,
    selection: modelSelection,
    explicitDefaultSelection: modelSelection.isDefault,
    markLiveSwitchPending: true,
  });
  if (!applied.updated) {
    return { resolved, changedModel: false };
  }
  const patched = await patchSessionEntryWithKey(
    { agentId, sessionKey: resolved.key, storePath: params.storePath },
    (entry, context) => {
      const next: SessionEntry = { ...entry };
      applyModelOverrideWithAuthProfileCompatibility({
        cfg,
        agentDir: params.agentDir,
        entry: next,
        currentProvider:
          entry.providerOverride?.trim() || entry.modelProvider?.trim() || configured.provider,
        selection: modelSelection,
        explicitDefaultSelection: modelSelection.isDefault,
        markLiveSwitchPending: true,
      });
      if (!next.sessionId.trim() && !context.existingEntry?.sessionId?.trim()) {
        next.sessionId = randomUUID();
      }
      return next;
    },
    { fallbackEntry: resolved.persisted ? undefined : resolved.entry, replaceEntry: true },
  );
  if (!patched) {
    throw new Error(`Unknown sessionKey: ${resolved.key}`);
  }
  triggerSessionPatchHook({
    cfg,
    sessionEntry: patched.entry,
    sessionKey: patched.sessionKey,
    patch: {
      key: patched.sessionKey,
      model: selection.kind === "reset" ? null : `${selection.provider}/${selection.model}`,
    },
  });
  return {
    resolved: { entry: patched.entry, key: patched.sessionKey, persisted: true },
    changedModel: true,
  };
}
