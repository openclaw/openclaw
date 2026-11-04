import { action, createMemo, createOptimistic, onSettled } from "solid-js";
import type {
  MigrationsMemoryApplyResult,
  MigrationsMemoryPlanResult,
} from "../../../../packages/gateway-protocol/src/schema/migrations.js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { SettingsPageHeader, LearnMoreLink } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerRouteSubtitlesEnglish } from "../../i18n/locales/en-route-subtitles.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import { projectAgentSelection, projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents } from "../../lib/reactive/domain-capabilities.ts";
import { projectMutableSource } from "../../lib/reactive/projection.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { MemoryImportClient, MemoryImportState } from "./memory-import-state.ts";
import type {
  SessionBackfillGatewayResult,
  SessionBackfillProgress,
  SessionBackfillRollbackResult,
} from "./view-types.ts";
import { MemoryImport } from "./view.tsx";

registerRouteSubtitlesEnglish();

const SESSION_BACKFILL_BATCH_DAYS = 14;
const MEMORY_IMPORT_DOCS_URL = "https://docs.openclaw.ai/install/migrating";

export function MemoryImportPage() {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const agents = projectAgents(context.agents);
  const selection = projectAgentSelection(context.agentSelection);
  let presentationScopeKey = gatewayPresentationScope(context.gateway).key;
  // Request state stays synchronous so a second activation observes the first immediately.
  const state: MemoryImportState = {
    replaceExisting: false,
    selectedByProvider: {},
    applyingProviderId: null,
    pendingImport: null,
    applyError: null,
    lastResults: {},
    backfillFrom: "",
    backfillTo: "",
    backfillBusy: null,
    backfillError: null,
    backfillPreview: null,
    backfillProgress: null,
    backfillRollbackResult: null,
    backfillRollbackTarget: null,
  };
  const source = projectMutableSource(state, (value) => value);
  const publish = source.publish;
  let presentationLifetime = Promise.withResolvers<void>();
  let planReceipt: { promise: Promise<void> } | null = null;
  let previewReceipt: { promise: Promise<void> } | null = null;
  function retirePresentation() {
    presentationLifetime.resolve();
    presentationLifetime = Promise.withResolvers<void>();
  }
  let applyEpoch = 0;
  let backfillEpoch = 0;
  let planError: string | null = null;
  let workspaceAuthorized = false;
  let lastPlanValue: {
    client: MemoryImportClient;
    agentId: string;
    overwrite: boolean;
    scopeKey: number;
    plan: MigrationsMemoryPlanResult;
  } | null = null;
  const read = <K extends keyof typeof state>(key: K) => {
    source.revision();
    return state[key];
  };

  const planRequest = createPageRequest(publish, {
    task: async (scope: Omit<NonNullable<typeof lastPlanValue>, "plan">, { signal }) => ({
      ...scope,
      plan: await scope.client.request<MigrationsMemoryPlanResult>(
        "migrations.memory.plan",
        { agentId: scope.agentId, overwrite: scope.overwrite },
        { signal },
      ),
    }),
    onComplete: (value) => {
      if (value.scopeKey !== gatewayPresentationScope(context.gateway).key) {
        return;
      }
      lastPlanValue = value;
      state.selectedByProvider = Object.fromEntries(
        value.plan.providers.map((provider) => [
          provider.providerId,
          provider.items
            .filter(
              (item) =>
                item.status === "planned" &&
                (state.selectedByProvider[provider.providerId]?.includes(item.id) ?? true),
            )
            .map((item) => item.id),
        ]),
      );
    },
    onError: (error) => {
      planError = formatUiError(error, "request failed");
    },
  });
  async function loadPlan() {
    const snapshot = context.gateway.snapshot;
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    const agentId = currentAgentId();
    const overwrite = state.replaceExisting;
    planError = null;
    if (!client || !canAdmin() || !agentId) {
      planReceipt = null;
      planRequest.reset();
      return;
    }
    planReceipt = {
      promise: planRequest.run({ client, agentId, overwrite, scopeKey: presentationScopeKey }),
    };
    publish();
    await planReceipt.promise;
  }
  let previousPlanArgs:
    | readonly [MemoryImportClient | null, boolean, boolean, string | null, boolean, number]
    | undefined;
  function syncPlan() {
    const next = [
      context.gateway.snapshot.client,
      context.gateway.snapshot.phase === "connected",
      canAdmin(),
      currentAgentId(),
      state.replaceExisting,
      gatewayPresentationScope(context.gateway).key,
    ] as const;
    const previous = previousPlanArgs;
    if (previous?.every((value, index) => value === next[index])) {
      return;
    }
    previousPlanArgs = next;
    const [client, connected, allowed, agentId, overwrite, scopeKey] = next;
    if (previous) {
      const identityChanged = previous[0] !== client || previous[5] !== scopeKey;
      const targetChanged = identityChanged || previous[3] !== agentId;
      const accessLost = connected && !allowed;
      if (targetChanged || previous[4] !== overwrite || accessLost) {
        // A temporarily missing roster is not a new destination; retain the unknown apply's key.
        resetMutationState({
          preserveAttemptedImport:
            !identityChanged &&
            !accessLost &&
            previous[4] === overwrite &&
            (agentId === null || agentId === state.pendingImport?.agentId),
        });
      }
      if (targetChanged || accessLost) {
        resetBackfillState();
      }
      if (identityChanged || accessLost) {
        lastPlanValue = null;
        workspaceAuthorized = false;
      }
      if (previous[1] !== connected) {
        retirePresentation();
        applyEpoch += 1;
        backfillEpoch += 1;
        state.applyingProviderId = null;
        state.backfillBusy = null;
      }
    }
    if (connected) {
      workspaceAuthorized = allowed;
    }
    presentationScopeKey = scopeKey;
    void loadPlan();
  }
  onSettled(() => {
    // Target/access receipts retire import and backfill epochs before replanning.
    const stops = [context.gateway, context.agents, context.agentSelection].map((owner) =>
      owner.subscribe(syncPlan),
    );
    stops.push(
      context.router.subscribe(() => {
        retirePresentation();
        publish();
      }),
    );
    syncPlan();
    return () => {
      stops.forEach((stop) => stop());
      presentationLifetime.resolve();
      applyEpoch += 1;
      backfillEpoch += 1;
      planRequest.cancel();
    };
  });
  function currentAgentId(): string | null {
    agents.read();
    selection.read();
    const list = context.agents.state.agentsList;
    if (!list) {
      return null;
    }
    const selectableAgents = listSelectableAgents(list.agents);
    const selected = context.agentSelection.state.selectedId;
    if (selected && selectableAgents.some((agent) => agent.id === selected)) {
      return selected;
    }
    return selectableAgents.some((agent) => agent.id === list.defaultId)
      ? list.defaultId
      : (selectableAgents[0]?.id ?? null);
  }

  function plan(): MigrationsMemoryPlanResult | null {
    source.revision();
    gateway.read();
    const value = lastPlanValue;
    const snapshot = context.gateway.snapshot;
    const agentId = currentAgentId();
    return value &&
      presentationScopeKey === gatewayPresentationScope(context.gateway).key &&
      value.client === snapshot.client &&
      value.agentId === agentId &&
      value.overwrite === state.replaceExisting
      ? value.plan
      : null;
  }

  function loading(): boolean {
    source.revision();
    return planRequest.pending;
  }
  function planFailure(): string | null {
    source.revision();
    return planError;
  }

  function canAdmin(): boolean {
    source.revision();
    gateway.read();
    const snapshot = context.gateway.snapshot;
    return snapshot.phase === "connected"
      ? hasOperatorAdminAccess(snapshot.hello?.auth ?? null)
      : workspaceAuthorized;
  }

  function resetMutationState(options: { preserveAttemptedImport?: boolean } = {}) {
    retirePresentation();
    // An interrupted apply has an unknown outcome. Keep its key so retries can
    // recover the cached server result instead of repeating side effects.
    const pendingImport =
      options.preserveAttemptedImport && state.pendingImport?.attempted
        ? state.pendingImport
        : null;
    applyEpoch += 1;
    state.selectedByProvider = {};
    state.applyingProviderId = null;
    state.pendingImport = pendingImport;
    state.applyError = null;
    state.lastResults = {};
    publish();
  }

  function refresh(): Promise<void> {
    const agentId = currentAgentId();
    if (context.agents.state.agentsError) {
      return context.agents.refreshList().then(() => {
        if (currentAgentId() === agentId) {
          return loadPlan();
        }
        return undefined;
      });
    }
    return agentId ? loadPlan() : context.agents.ensureList().then(() => undefined);
  }

  function toggleCollection(providerId: string, itemIds: readonly string[], selected: boolean) {
    const next = new Set(state.selectedByProvider[providerId] ?? []);
    for (const itemId of itemIds) {
      if (selected) {
        next.add(itemId);
      } else {
        next.delete(itemId);
      }
    }
    state.selectedByProvider = { ...state.selectedByProvider, [providerId]: [...next] };
    publish();
  }

  function requestImport(providerId: string) {
    if (context.gateway.snapshot.phase !== "connected" || !canAdmin()) {
      return;
    }
    const agentId = currentAgentId();
    const planFingerprint = plan()?.providers.find(
      (provider) => provider.providerId === providerId,
    )?.planFingerprint;
    const itemIds = state.selectedByProvider[providerId] ?? [];
    if (
      loading() ||
      planFailure() !== null ||
      state.applyingProviderId !== null ||
      state.backfillBusy === "apply" ||
      state.backfillBusy === "rollback" ||
      state.backfillRollbackTarget !== null ||
      !agentId ||
      plan()?.agentId !== agentId ||
      !planFingerprint ||
      itemIds.length === 0
    ) {
      return;
    }
    state.applyError = null;
    state.pendingImport = {
      providerId,
      agentId,
      planFingerprint,
      itemIds: [...itemIds],
      overwrite: state.replaceExisting,
      idempotencyKey: generateUUID(),
      attempted: false,
    };
    publish();
  }

  async function confirmImport() {
    if (
      context.gateway.snapshot.phase !== "connected" ||
      !canAdmin() ||
      state.applyingProviderId !== null ||
      state.backfillBusy === "apply" ||
      state.backfillBusy === "rollback" ||
      state.backfillRollbackTarget !== null
    ) {
      return;
    }
    const pending = state.pendingImport;
    const snapshot = context.gateway.snapshot;
    if (
      !pending ||
      !snapshot.client ||
      currentAgentId() !== pending.agentId ||
      plan()?.agentId !== pending.agentId
    ) {
      return;
    }
    const attemptedImport = { ...pending, attempted: true };
    const client = snapshot.client;
    state.pendingImport = attemptedImport;
    const epoch = ++applyEpoch;
    state.applyingProviderId = attemptedImport.providerId;
    state.applyError = null;
    publish();
    try {
      const result = await client.request<MigrationsMemoryApplyResult>("migrations.memory.apply", {
        idempotencyKey: attemptedImport.idempotencyKey,
        agentId: attemptedImport.agentId,
        providerId: attemptedImport.providerId,
        planFingerprint: attemptedImport.planFingerprint,
        itemIds: attemptedImport.itemIds,
        overwrite: attemptedImport.overwrite,
      });
      if (
        epoch !== applyEpoch ||
        context.gateway.snapshot.phase !== "connected" ||
        context.gateway.snapshot.client !== client ||
        currentAgentId() !== attemptedImport.agentId
      ) {
        return;
      }
      state.lastResults = { ...state.lastResults, [attemptedImport.providerId]: result };
      state.pendingImport = null;
      await refresh();
    } catch (error) {
      if (epoch === applyEpoch) {
        state.applyError = formatUiError(error, "request failed");
      }
    } finally {
      if (epoch === applyEpoch) {
        state.applyingProviderId = null;
        publish();
      }
    }
  }

  function resetBackfillState() {
    retirePresentation();
    backfillEpoch += 1;
    state.backfillFrom = "";
    state.backfillTo = "";
    state.backfillBusy = null;
    state.backfillError = null;
    clearBackfillResults();
    state.backfillRollbackTarget = null;
    publish();
  }

  function clearBackfillResults() {
    previewReceipt = null;
    state.backfillPreview = null;
    state.backfillProgress = null;
    state.backfillRollbackResult = null;
  }

  function setBackfillDate(field: "backfillFrom" | "backfillTo", value: string) {
    state[field] = value;
    clearBackfillResults();
    state.backfillError = null;
    publish();
  }

  async function runBackfill(operation: "preview" | "apply" | "rollback") {
    const client = context.gateway.snapshot.client;
    const agentId = currentAgentId();
    const scopeKey = presentationScopeKey;
    if (
      context.gateway.snapshot.phase !== "connected" ||
      scopeKey !== gatewayPresentationScope(context.gateway).key ||
      !canAdmin() ||
      !client ||
      !agentId ||
      state.backfillBusy !== null ||
      state.applyingProviderId !== null ||
      (operation === "rollback" &&
        (state.backfillRollbackTarget?.client !== client ||
          state.backfillRollbackTarget?.agentId !== agentId))
    ) {
      return;
    }
    const epoch = ++backfillEpoch;
    const isCurrent = () =>
      epoch === backfillEpoch &&
      scopeKey === gatewayPresentationScope(context.gateway).key &&
      context.gateway.snapshot.phase === "connected" &&
      context.gateway.snapshot.client === client &&
      currentAgentId() === agentId;
    state.backfillBusy = operation;
    state.backfillError = null;
    if (operation !== "rollback") {
      clearBackfillResults();
    }
    publish();
    const requestBackfill = (method: "preview" | "apply") =>
      client.request<SessionBackfillGatewayResult>(`memory.sessionBackfill.${method}`, {
        agentId,
        ...(state.backfillFrom ? { from: state.backfillFrom } : {}),
        ...(state.backfillTo ? { to: state.backfillTo } : {}),
        limitDays: SESSION_BACKFILL_BATCH_DAYS,
      });
    try {
      if (operation === "rollback") {
        const result = await client.request<SessionBackfillRollbackResult>(
          "memory.sessionBackfill.rollback",
          { agentId },
        );
        if (isCurrent()) {
          state.backfillRollbackResult = result;
          state.backfillPreview = null;
          state.backfillProgress = null;
          state.backfillRollbackTarget = null;
        }
      } else if (operation === "preview") {
        const result = await requestBackfill("preview");
        if (isCurrent()) {
          state.backfillPreview = result;
        }
      } else {
        let progress: SessionBackfillProgress = {
          days: 0,
          candidates: 0,
          staged: 0,
          complete: false,
        };
        state.backfillProgress = progress;
        const processedDays = new Set<string>();
        while (true) {
          const chunk = await requestBackfill("apply");
          if (!isCurrent()) {
            return;
          }
          if (chunk.candidates > 0 && chunk.cursor?.advanced !== true) {
            throw new Error("Session backfill stopped because the server cursor did not advance.");
          }
          if (chunk.candidates === 0 && chunk.cursor?.exhausted !== true) {
            throw new Error(
              "Session backfill stopped because the server cursor was not exhausted.",
            );
          }
          for (const day of chunk.perDay) {
            processedDays.add(day.day);
          }
          progress = {
            days: processedDays.size,
            candidates: progress.candidates + chunk.candidates,
            staged: progress.staged + chunk.staged,
            complete: chunk.candidates === 0,
          };
          state.backfillProgress = progress;
          publish();
          // A zero-candidate call is the idempotent completion sentinel; cursor metadata proves
          // that the server's persisted scan agrees before the client stops driving chunks.
          if (chunk.candidates === 0) {
            break;
          }
        }
      }
    } catch (error) {
      if (isCurrent()) {
        state.backfillError = formatUiError(error, "request failed");
      }
    } finally {
      if (isCurrent()) {
        state.backfillBusy = null;
        publish();
      }
    }
  }

  const presentationScope = createMemo(() => {
    source.revision();
    return presentationLifetime;
  });
  const presentation = createMemo(() => {
    const retired = presentationScope().promise;
    const [importing, setImporting] = createOptimistic<string | null>(null);
    const [backfilling, setBackfilling] = createOptimistic<typeof state.backfillBusy>(null);
    return { retired, importing, setImporting, backfilling, setBackfilling };
  });
  const admittedPlan = createMemo(() => {
    source.revision();
    return planReceipt;
  });
  const acceptedPlan = createMemo(plan);
  const planErrorValue = createMemo(planFailure);
  const planRead = createMemo(() => {
    const pending = admittedPlan()?.promise;
    const value = acceptedPlan();
    const error = planErrorValue();
    const retired = presentationScope().promise;
    if (!loading()) {
      if (!value && error) {
        throw new Error(error);
      }
      return value;
    }
    return pending
      ? Promise.race([pending, retired]).then(() => {
          const result = plan();
          if (!result && planError) {
            throw new Error(planError);
          }
          return result;
        })
      : value;
  });
  const admittedPreview = createMemo(() => {
    source.revision();
    return previewReceipt;
  });
  const previewValue = createMemo(() => read("backfillPreview"));
  const previewError = createMemo(() => read("backfillError"));
  const previewRead = createMemo(() => {
    const pending = admittedPreview()?.promise;
    const value = previewValue();
    const error = previewError();
    const retired = presentationScope().promise;
    if (read("backfillBusy") !== "preview") {
      if (pending && !value && error) {
        throw new Error(error);
      }
      return value;
    }
    return pending
      ? Promise.race([pending, retired]).then(() => {
          if (!state.backfillPreview && state.backfillError) {
            throw new Error(state.backfillError);
          }
          return state.backfillPreview;
        })
      : value;
  });
  const presentMutation = action(function* (
    current: ReturnType<typeof presentation>,
    pending: Promise<void>,
    kind: "import" | "apply" | "rollback",
    providerId: string | null,
  ) {
    if (current.retired === presentationLifetime.promise) {
      if (kind === "import") {
        current.setImporting(providerId);
      } else {
        current.setBackfilling(kind);
      }
    }
    // The owner records failures and settles the operation after its presentation retires.
    yield Promise.race([pending, current.retired]);
  });
  async function importMemory() {
    const current = presentation();
    const pending = confirmImport();
    const providerId = state.applyingProviderId;
    if (providerId === null) {
      return pending;
    }
    await Promise.resolve();
    return presentMutation(current, pending, "import", providerId);
  }
  async function backfill(operation: "preview" | "apply" | "rollback") {
    const current = presentation();
    const pending = runBackfill(operation);
    if (state.backfillBusy !== operation) {
      return pending;
    }
    if (operation === "preview") {
      previewReceipt = { promise: pending };
      publish();
      return pending;
    }
    await Promise.resolve();
    return presentMutation(current, pending, operation, null);
  }

  return (
    <openclaw-memory-import-page>
      <SettingsPageHeader
        title={titleForRoute("memory-import")}
        subtitle={
          <>
            {subtitleForRoute("memory-import")} <LearnMoreLink url={MEMORY_IMPORT_DOCS_URL} />
          </>
        }
      />
      <SettingsWorkspace>
        <MemoryImport
          connected={gateway.read().snapshot.phase === "connected"}
          canAdmin={canAdmin()}
          agents={listSelectableAgents(agents.read().agentsList?.agents ?? [])}
          selectedAgentId={currentAgentId()}
          plan={plan()}
          readPlan={planRead}
          readPreview={previewRead}
          readScope={presentationScope()}
          loading={loading() || agents.read().agentsLoading}
          error={
            (currentAgentId() ? null : agents.read().agentsError) ?? (plan() ? planFailure() : null)
          }
          applyError={read("applyError")}
          replaceExisting={read("replaceExisting")}
          selectedByProvider={read("selectedByProvider")}
          applyingProviderId={presentation().importing() ?? read("applyingProviderId")}
          pendingProviderId={
            read("pendingImport")?.agentId === currentAgentId()
              ? state.pendingImport!.providerId
              : null
          }
          lastResults={read("lastResults")}
          backfillAvailable={
            isGatewayMethodAdvertised(gateway.read().snapshot, "memory.sessionBackfill.preview") !==
            false
          }
          backfillFrom={read("backfillFrom")}
          backfillTo={read("backfillTo")}
          backfillBusy={presentation().backfilling() ?? read("backfillBusy")}
          backfillError={
            admittedPreview() && !read("backfillPreview") ? null : read("backfillError")
          }
          backfillProgress={read("backfillProgress")}
          backfillRollbackResult={read("backfillRollbackResult")}
          backfillRollbackPending={read("backfillRollbackTarget") !== null}
          onSelectAgent={(agentId) => {
            resetMutationState();
            resetBackfillState();
            context.agentSelection.set(agentId);
          }}
          onReplaceExisting={(enabled) => {
            state.replaceExisting = enabled;
            resetMutationState();
            syncPlan();
          }}
          onRefresh={() => void refresh()}
          onToggleCollection={toggleCollection}
          onRequestImport={requestImport}
          onConfirmImport={() => void importMemory()}
          onCancelImport={() => {
            if (state.applyingProviderId === null) {
              state.pendingImport = null;
              state.applyError = null;
              publish();
            }
          }}
          onBackfillFromChange={(value) => setBackfillDate("backfillFrom", value)}
          onBackfillToChange={(value) => setBackfillDate("backfillTo", value)}
          onBackfillPreview={() => void backfill("preview")}
          onBackfillApply={() => void backfill("apply")}
          onBackfillRollbackRequest={() => {
            const snapshot = context.gateway.snapshot;
            const agentId = currentAgentId();
            if (
              state.backfillBusy === null &&
              snapshot.phase === "connected" &&
              snapshot.client &&
              agentId
            ) {
              state.backfillRollbackTarget = { client: snapshot.client, agentId };
              state.backfillError = null;
              publish();
            }
          }}
          onBackfillRollbackConfirm={() => void backfill("rollback")}
          onBackfillRollbackCancel={() => {
            if (state.backfillBusy === null) {
              state.backfillRollbackTarget = null;
              publish();
            }
          }}
        />
      </SettingsWorkspace>
    </openclaw-memory-import-page>
  );
}
