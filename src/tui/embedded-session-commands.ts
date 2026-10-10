import { randomUUID } from "node:crypto";
import type { ErrorShape, SessionsPatchResult } from "../../packages/gateway-protocol/src/index.js";
import { prepareAcpSessionEntryRead } from "../acp/runtime/session-meta-read.js";
import { readAcpSessionMetaForEntries } from "../acp/runtime/session-meta-readonly.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveSharedAuthStoreOwnershipAsync } from "../agents/auth-profiles/path-resolve.js";
import { loadPreparedModelCatalogSnapshot } from "../agents/prepared-model-catalog.js";
import { executeSessionGoalCommand, parseGoalCommand } from "../auto-reply/reply/commands-goal.js";
import { getRuntimeConfig } from "../config/config.js";
import { applySessionPatchProjection } from "../config/sessions/session-accessor.js";
import { captureSessionEntrySourceAssertion } from "../config/sessions/session-entry-source-authority.js";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionActor,
} from "../config/sessions/session-incognito-binding.js";
import { createGatewaySession } from "../gateway/session-create-service.js";
import { performGatewaySessionReset } from "../gateway/session-reset-service.js";
import { projectSessionPatchResult } from "../gateway/session-utils-model.js";
import {
  loadSessionEntry,
  loadGatewaySessionEntryReadOnly,
  resolveCanonicalGatewaySessionStoreKey,
  resolveGatewaySessionStoreTargetWithStore,
} from "../gateway/session-utils.js";
import { projectSessionsPatchEntry } from "../gateway/sessions-patch.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  withEmbeddedSessionSource,
  type SelectedEmbeddedSession,
} from "./embedded-session-source.js";
import type { TuiBackend, TuiSessionCreateOptions } from "./tui-backend.js";

export function createEmbeddedSessionCommands(lifecycle: {
  ready: () => Promise<void>;
  modelRuntimeReady: () => Promise<void>;
}) {
  async function patchSession(
    opts: Parameters<TuiBackend["patchSession"]>[0],
  ): Promise<SessionsPatchResult> {
    return withEmbeddedSessionSource(opts.key, opts.agentId, (selected, assertSelected) =>
      patchSessionFromSource(opts, selected, assertSelected),
    );
  }

  async function patchSessionFromSource(
    opts: Parameters<TuiBackend["patchSession"]>[0],
    selected: SelectedEmbeddedSession | undefined,
    assertSelected: () => void,
  ) {
    const catalogSource = selected ? captureOpenClawStateWorkerContext() : undefined;
    await lifecycle.ready();
    await lifecycle.modelRuntimeReady();
    const cfg = getRuntimeConfig();
    const target =
      selected ??
      resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: opts.key,
        agentId: opts.agentId,
        exactRead: true,
      });
    assertSelected();
    const preparedAcp = selected
      ? await prepareAcpSessionEntryRead({
          cfg,
          sessionKey: selected.canonicalKey,
          agentId: selected.agentId,
          assertCurrent: assertSelected,
        })
      : undefined;
    if (selected && !preparedAcp) {
      throw new Error("Local session lost its bound ACP metadata source");
    }
    const assertPatchCurrent = () => {
      assertSelected();
      preparedAcp?.assertCurrent();
    };
    const applied = await applySessionPatchProjection<{ ok: false; error: ErrorShape }>({
      assertCurrent: assertPatchCurrent,
      ...(preparedAcp ? { assertCommitAllowed: assertPatchCurrent } : {}),
      ...(opts.label === undefined ? { sessionKeys: target.storeKeys } : {}),
      storePath: target.storePath,
      resolveTarget: ({ store }) => {
        if (selected) {
          return { primaryKey: selected.canonicalKey, candidateKeys: selected.storeKeys };
        }
        const { target: migratedTarget, primaryKey } = resolveCanonicalGatewaySessionStoreKey({
          cfg,
          key: opts.key,
          store,
          agentId: opts.agentId,
        });
        return { primaryKey, candidateKeys: migratedTarget.storeKeys };
      },
      project: async ({ primaryKey, existingEntry, isLabelInUse }) =>
        await projectSessionsPatchEntry({
          cfg,
          existingEntry,
          isLabelInUse,
          storeKey: primaryKey,
          agentId: target.agentId,
          patch: opts,
          ...(preparedAcp ? { preparedAcpMeta: preparedAcp.session?.acp ?? null } : {}),
          loadGatewayModelCatalogSnapshot: async () => {
            if (catalogSource) {
              assertSelected();
              await resolveSharedAuthStoreOwnershipAsync(catalogSource);
              assertSelected();
            }
            const catalog = await loadPreparedModelCatalogSnapshot({
              config: cfg,
              agentId: target.agentId,
              readOnly: true,
              ...(catalogSource ? { env: catalogSource.initializationEnvironment } : {}),
            });
            catalogSource?.maintenanceScope?.assertAdmission();
            catalogSource?.admission.assertCurrent();
            assertSelected();
            return catalog;
          },
        }),
    }).finally(() => preparedAcp?.release());
    if (!applied.ok) {
      throw new Error(applied.error.message);
    }

    const canonicalKey = target.canonicalKey ?? opts.key;
    const assertApplied = selected
      ? captureSessionEntrySourceAssertion({
          scope: { agentId: target.agentId, sessionKey: canonicalKey, storePath: target.storePath },
          expected: applied.entry,
          fields: ["sessionId", "lifecycleRevision"],
          assertCurrent() {},
          refuse() {
            throw new Error("Local session changed while preparing the patch result");
          },
        })
      : assertSelected;
    assertApplied();
    const [acpMeta] = await readAcpSessionMetaForEntries({
      cfg,
      entries: [{ agentId: target.agentId, sessionKey: canonicalKey, entry: applied.entry }],
    });
    assertApplied();
    const projected = projectSessionPatchResult({
      canonicalKey,
      cfg,
      entry: applied.entry,
      preparedAcpMeta: acpMeta ?? null,
      storePath: target.storePath,
      targetAgentId: target.agentId,
    });
    return { ...projected, entry: { ...projected.entry } };
  }

  async function resetSession(key: string, reason?: "new" | "reset", opts?: { agentId?: string }) {
    return withEmbeddedSessionSource(key, opts?.agentId, (selected, assertSelected) =>
      resetSessionFromSource(key, reason, opts, selected, assertSelected),
    );
  }

  async function resetSessionFromSource(
    key: string,
    reason: "new" | "reset" | undefined,
    opts: { agentId?: string } | undefined,
    selected: SelectedEmbeddedSession | undefined,
    assertSelected: () => void,
  ) {
    await lifecycle.ready();
    assertSelected();
    if ((selected ?? loadGatewaySessionEntryReadOnly(key, opts)).entry?.incognito === true) {
      throw new Error("Incognito sessions cannot reset in place.");
    }
    const result = await performGatewaySessionReset({
      key,
      operatorRoleActor: { kind: "system" },
      ...(opts?.agentId ? { agentId: opts.agentId } : {}),
      reason: reason === "new" ? "new" : "reset",
      commandSource: "tui:embedded",
      armSessionDiffBaselineCapture: true,
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    if ("incognitoDeleted" in result) {
      return { ok: true as const, key: result.key, deleted: true as const };
    }
    return { ok: true as const, key: result.key, entry: result.entry, resolved: result.resolved };
  }

  async function createSession(opts: TuiSessionCreateOptions) {
    const source = captureIncognitoSessionSource({ sessionKey: opts.key, agentId: opts.agentId });
    const create = async () => {
      await lifecycle.ready();
      await lifecycle.modelRuntimeReady();
      const cfg = getRuntimeConfig();
      const result = await createGatewaySession({
        cfg,
        operatorRoleActor: { kind: "system" },
        ...opts,
        ...(source && !("kind" in source) && isIncognitoSessionKey(opts.key)
          ? { incognito: true }
          : {}),
        creation: { via: "operator", actor: { type: "human", source: "unknown" } },
        armSessionDiffBaselineCapture: true,
        emitCommandHooks: Boolean(opts.parentSessionKey),
        commandSource: "tui:embedded",
        loadGatewayModelCatalogSnapshot: () =>
          loadPreparedModelCatalogSnapshot({
            config: cfg,
            agentId: resolveSessionAgentId({
              sessionKey: opts.key,
              config: cfg,
              agentId: opts.agentId,
            }),
            readOnly: true,
          }),
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return {
        ok: true as const,
        key: result.key,
        entry: result.entry,
        resolved: result.resolved,
      };
    };
    return source && !("kind" in source)
      ? withIncognitoSessionActor(source.actor, create, source.admissionSignal)
      : create();
  }

  async function runGoalCommand(opts: Parameters<NonNullable<TuiBackend["runGoalCommand"]>>[0]) {
    return withEmbeddedSessionSource(opts.sessionKey, opts.agentId, (selected, assertSelected) =>
      runGoalCommandFromSource(opts, selected, assertSelected),
    );
  }

  async function runGoalCommandFromSource(
    opts: Parameters<NonNullable<TuiBackend["runGoalCommand"]>>[0],
    selected: SelectedEmbeddedSession | undefined,
    assertSelected: () => void,
  ) {
    await lifecycle.ready();
    const loadOptions = opts.agentId ? { agentId: opts.agentId } : undefined;
    const { agentId, canonicalKey, storePath, entry } =
      selected ?? loadSessionEntry(opts.sessionKey, loadOptions);
    assertSelected();
    const parsed = parseGoalCommand(opts.command.trim());
    if (!parsed) {
      throw new Error("invalid goal command");
    }

    const result = await executeSessionGoalCommand({
      parsed,
      sessionKey: canonicalKey,
      storePath,
      fallbackEntry: entry ?? { sessionId: randomUUID(), updatedAt: Date.now() },
      agentId,
    });
    return result.continuationPrompt
      ? { text: result.text, continuationPrompt: result.continuationPrompt }
      : { text: result.text };
  }

  async function runUsageCostCommand(
    opts: Parameters<NonNullable<TuiBackend["runUsageCostCommand"]>>[0],
  ) {
    return withEmbeddedSessionSource(opts.sessionKey, opts.agentId, (selected, assertSelected) =>
      runUsageCostCommandFromSource(opts, selected, assertSelected),
    );
  }

  async function runUsageCostCommandFromSource(
    opts: Parameters<NonNullable<TuiBackend["runUsageCostCommand"]>>[0],
    selected: SelectedEmbeddedSession | undefined,
    assertSelected: () => void,
  ) {
    await lifecycle.ready();
    const { cfg, agentId, canonicalKey, storePath, entry } =
      selected ??
      loadSessionEntry(opts.sessionKey, opts.agentId ? { agentId: opts.agentId } : undefined);
    const { formatSessionUsageCostSummary } =
      await import("../auto-reply/reply/commands-session-cost.runtime.js");
    assertSelected();
    const text = await formatSessionUsageCostSummary({
      cfg,
      sessionKey: canonicalKey,
      agentId,
      sessionEntry: entry,
      storePath,
    });
    assertSelected();
    return { text };
  }

  return { patchSession, resetSession, createSession, runGoalCommand, runUsageCostCommand };
}
