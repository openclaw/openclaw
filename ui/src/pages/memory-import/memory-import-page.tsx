import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type {
  MigrationsMemoryApplyResult,
  MigrationsMemoryPlanResult,
} from "../../../../packages/gateway-protocol/src/schema/migrations.js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { SettingsPageHeader, LearnMoreLink } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { projectAgentSelection, projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents } from "../../lib/reactive/domain-capabilities.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import type {
  SessionBackfillGatewayResult,
  SessionBackfillProgress,
  SessionBackfillRollbackResult,
} from "./view-types.ts";
import { MemoryImport } from "./view.tsx";

const SESSION_BACKFILL_BATCH_DAYS = 14;
const MEMORY_IMPORT_DOCS_URL = "https://docs.openclaw.ai/install/migrating";

type MemoryImportClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;

type PendingMemoryImport = {
  providerId: string;
  agentId: string;
  planFingerprint: string;
  itemIds: string[];
  overwrite: boolean;
  idempotencyKey: string;
  attempted: boolean;
};

export const MemoryImportPage = defineSolidBridge(
  "openclaw-memory-import-page",
  () => {
    const context = useApplication();
    const gateway = projectGateway(context.gateway);
    const agents = projectAgents(context.agents);
    const selection = projectAgentSelection(context.agentSelection);
    const [revision, setRevision] = createSignal(0, { ownedWrite: true });
    const publish = () => setRevision((value) => value + 1);
    // Request state stays synchronous so a second activation observes the first immediately.
    const state: {
      replaceExisting: boolean;
      selectedByProvider: Record<string, string[]>;
      applyingProviderId: string | null;
      pendingImport: PendingMemoryImport | null;
      applyError: string | null;
      lastResults: Record<string, MigrationsMemoryApplyResult>;
      backfillFrom: string;
      backfillTo: string;
      backfillBusy: "preview" | "apply" | "rollback" | null;
      backfillError: string | null;
      backfillPreview: SessionBackfillGatewayResult | null;
      backfillProgress: SessionBackfillProgress | null;
      backfillRollbackResult: SessionBackfillRollbackResult | null;
      backfillRollbackTarget: { client: MemoryImportClient; agentId: string } | null;
    } = {
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
    let applyEpoch = 0;
    let backfillEpoch = 0;
    let planEpoch = 0;
    let planAbort: AbortController | undefined;
    let planLoading = false;
    let planError: string | null = null;
    let lastPlanValue: {
      client: MemoryImportClient;
      agentId: string;
      overwrite: boolean;
      plan: MigrationsMemoryPlanResult;
    } | null = null;
    const read = <K extends keyof typeof state>(key: K) => {
      revision();
      return state[key];
    };

    const planArgs = createMemo(
      () => {
        gateway.read();
        return [
          context.gateway.snapshot.phase === "connected" ? context.gateway.snapshot.client : null,
          canAdmin(),
          currentAgentId(),
          read("replaceExisting"),
        ] as const;
      },
      { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
    );

    async function loadPlan() {
      const snapshot = context.gateway.snapshot;
      const client = snapshot.phase === "connected" ? snapshot.client : null;
      const agentId = currentAgentId();
      const overwrite = state.replaceExisting;
      const epoch = ++planEpoch;
      planAbort?.abort();
      planAbort = undefined;
      planError = null;
      planLoading = Boolean(client && canAdmin() && agentId);
      publish();
      if (!client || !canAdmin() || !agentId) {
        return;
      }
      const abort = new AbortController();
      planAbort = abort;
      try {
        const nextPlan = await client.request<MigrationsMemoryPlanResult>(
          "migrations.memory.plan",
          { agentId, overwrite },
          { signal: abort.signal },
        );
        if (epoch !== planEpoch) {
          return;
        }
        lastPlanValue = { client, agentId, overwrite, plan: nextPlan };
        state.selectedByProvider = Object.fromEntries(
          nextPlan.providers.map((provider) => [
            provider.providerId,
            provider.items.filter((item) => item.status === "planned").map((item) => item.id),
          ]),
        );
      } catch (error) {
        if (epoch === planEpoch) {
          planError = formatUiError(error, "request failed");
        }
      } finally {
        if (epoch === planEpoch) {
          planLoading = false;
          publish();
        }
      }
    }

    createEffect(planArgs, ([client, , agentId, overwrite], previous) => {
      if (previous) {
        const connectionChanged = previous[0] !== client;
        const targetChanged = connectionChanged || previous[2] !== agentId;
        if (targetChanged || previous[3] !== overwrite) {
          resetMutationState({ preserveAttemptedImport: connectionChanged });
        }
        if (targetChanged) {
          resetBackfillState();
        }
      }
      void loadPlan();
    });
    onCleanup(() => {
      planEpoch += 1;
      applyEpoch += 1;
      backfillEpoch += 1;
      planAbort?.abort();
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
      revision();
      gateway.read();
      const value = lastPlanValue;
      const snapshot = context.gateway.snapshot;
      const agentId = currentAgentId();
      return value &&
        snapshot.phase === "connected" &&
        value.client === snapshot.client &&
        value.agentId === agentId &&
        value.overwrite === state.replaceExisting
        ? value.plan
        : null;
    }

    function loading(): boolean {
      revision();
      return planLoading;
    }
    function planFailure(): string | null {
      revision();
      return planError;
    }

    function canAdmin(): boolean {
      return hasOperatorAdminAccess(context.gateway.snapshot.hello?.auth ?? null);
    }

    function resetMutationState(options: { preserveAttemptedImport?: boolean } = {}) {
      // A disconnected apply has an unknown outcome. Keep its key so reconnect retries can
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
      return currentAgentId() ? loadPlan() : context.agents.ensureList().then(() => undefined);
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
      if (!canAdmin()) {
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
        const result = await client.request<MigrationsMemoryApplyResult>(
          "migrations.memory.apply",
          {
            idempotencyKey: attemptedImport.idempotencyKey,
            agentId: attemptedImport.agentId,
            providerId: attemptedImport.providerId,
            planFingerprint: attemptedImport.planFingerprint,
            itemIds: attemptedImport.itemIds,
            overwrite: attemptedImport.overwrite,
          },
        );
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
      if (
        context.gateway.snapshot.phase !== "connected" ||
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
              throw new Error(
                "Session backfill stopped because the server cursor did not advance.",
              );
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

    return (
      <>
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
            canAdmin={hasOperatorAdminAccess(gateway.read().snapshot.hello?.auth ?? null)}
            agents={listSelectableAgents(agents.read().agentsList?.agents ?? [])}
            selectedAgentId={currentAgentId()}
            plan={plan()}
            loading={loading() || agents.read().agentsLoading}
            error={(currentAgentId() ? null : agents.read().agentsError) ?? planFailure()}
            applyError={read("applyError")}
            replaceExisting={read("replaceExisting")}
            selectedByProvider={read("selectedByProvider")}
            applyingProviderId={read("applyingProviderId")}
            pendingProviderId={
              read("pendingImport")?.agentId === currentAgentId()
                ? state.pendingImport!.providerId
                : null
            }
            lastResults={read("lastResults")}
            backfillAvailable={
              isGatewayMethodAdvertised(
                gateway.read().snapshot,
                "memory.sessionBackfill.preview",
              ) !== false
            }
            backfillFrom={read("backfillFrom")}
            backfillTo={read("backfillTo")}
            backfillBusy={read("backfillBusy")}
            backfillError={read("backfillError")}
            backfillPreview={read("backfillPreview")}
            backfillProgress={read("backfillProgress")}
            backfillRollbackResult={read("backfillRollbackResult")}
            backfillRollbackPending={read("backfillRollbackTarget") !== null}
            onSelectAgent={(agentId) => {
              context.agentSelection.set(agentId);
              resetMutationState();
              resetBackfillState();
            }}
            onReplaceExisting={(enabled) => {
              state.replaceExisting = enabled;
              resetMutationState();
            }}
            onRefresh={() => void refresh()}
            onToggleCollection={toggleCollection}
            onRequestImport={requestImport}
            onConfirmImport={() => void confirmImport()}
            onCancelImport={() => {
              if (state.applyingProviderId === null) {
                state.pendingImport = null;
                state.applyError = null;
                publish();
              }
            }}
            onBackfillFromChange={(value) => setBackfillDate("backfillFrom", value)}
            onBackfillToChange={(value) => setBackfillDate("backfillTo", value)}
            onBackfillPreview={() => void runBackfill("preview")}
            onBackfillApply={() => void runBackfill("apply")}
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
            onBackfillRollbackConfirm={() => void runBackfill("rollback")}
            onBackfillRollbackCancel={() => {
              if (state.backfillBusy === null) {
                state.backfillRollbackTarget = null;
                publish();
              }
            }}
          />
        </SettingsWorkspace>
      </>
    );
  },
  { properties: {} },
);
