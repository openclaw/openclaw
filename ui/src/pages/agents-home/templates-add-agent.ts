import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { routeIdFromPath } from "../../app-route-paths.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { retainCreatedComposer } from "../new-session/creation-composer-registry.ts";
import { CreationComposer } from "../new-session/creation-composer.ts";
import {
  applyTemplateAdd,
  type TemplateAddReviewPlan,
  type TemplateCatalogSource,
} from "./templates-catalog-client.ts";

/** Like sidebar New agent, the application owns the handoff after its initiating page closes. */
export async function addTemplateAgent(
  context: ApplicationContext,
  source: TemplateCatalogSource,
  plan: TemplateAddReviewPlan,
  acknowledgeClawHubRisk: boolean,
) {
  const client = context.gateway.snapshot.client;
  const scopeKey = gatewayPresentationScope(context.gateway).key;
  const isCurrent = () =>
    context.gateway.snapshot.client === client &&
    gatewayPresentationScope(context.gateway).key === scopeKey;
  const agentId = plan.target.agentId;
  if (!client || !agentId) {
    throw new Error(t("templatesCatalog.addFailed"));
  }
  const name = plan.target.name ?? agentId;
  const pending = context.agents.beginCreation({ id: agentId, name });
  if (!pending) {
    return;
  }
  const initialLocation = context.router.getState().location;
  const initialRoute = routeIdFromPath(initialLocation.pathname, context.basePath);
  const selectionRevision = context.agentSelection.intentRevision;
  const creation = {
    sessionKey: buildAgentMainSessionKey({
      agentId,
      mainKey: resolveUiConfiguredMainKey({
        agentsList: context.agents.state.agentsList,
        hello: context.gateway.snapshot.hello,
      }),
    }),
    admitted: false,
  };
  let durable = false;
  const target = sessionNavigationTarget({
    context,
    face: "chat",
    sessionKey: creation.sessionKey,
    agentId,
    exactKey: true,
  });
  const composer = new CreationComposer(context, agentId, false, () => {});
  const clearChat = context.chatSubmissions.beginCreate({
    creation,
    composer,
    displayName: name,
    message: null,
    canDisplay: () =>
      isCurrent() && context.router.getState().location.pathname === target.options.pathname,
  });
  context.navigate("chat", target.options);
  const location = context.router.getState().location;
  const ownsForeground = () =>
    context.router.getState().location === location &&
    context.agentSelection.intentRevision === selectionRevision;
  const durableAdmission = (saved: { agentId: string; sessionKey: string }) => {
    if (durable || !isCurrent() || !pending.isCurrent()) {
      return;
    }
    durable = true;
    composer.accept(
      { key: saved.sessionKey, initialRun: { status: "idle" } },
      { initializationPending: true },
    );
    retainCreatedComposer(context, saved.sessionKey, composer);
    pending.complete({ id: saved.agentId, name });
    void context.agents.refreshList();
  };
  const admit = (ready: { agentId: string; sessionKey: string }) => {
    if (creation.admitted || !isCurrent() || (!durable && !pending.isCurrent())) {
      return;
    }
    const foreground = ownsForeground();
    composer.error = null;
    composer.recovery = undefined;
    composer.accept({ key: ready.sessionKey, initialRun: { status: "idle" } });
    retainCreatedComposer(context, ready.sessionKey, composer);
    creation.admitted = true;
    pending.complete({ id: ready.agentId, name });
    void context.agents.refreshList();
    if (foreground) {
      selectApplicationSession({
        selection: context.agentSelection,
        gateway: context.gateway,
        sessionKey: ready.sessionKey,
        agentId: ready.agentId,
      });
      if (ready.sessionKey !== creation.sessionKey) {
        const canonical = sessionNavigationTarget({
          context,
          face: "chat",
          sessionKey: ready.sessionKey,
          agentId: ready.agentId,
          exactKey: true,
        });
        context.replace("chat", canonical.options);
      }
    }
    clearChat();
  };
  let applying = false;
  const apply = async () => {
    if (
      applying ||
      !isCurrent() ||
      creation.admitted ||
      (durable && (!composer.canDisplay() || context.chatSubmissions.creation !== creation))
    ) {
      return;
    }
    applying = true;
    if (composer.recovery) {
      composer.recovery.pending = true;
      composer.error = null;
      composer.notify();
    }
    let requestId: string | undefined;
    const unsubscribe = context.gateway.subscribeEvents((event) => {
      const payload = event.payload;
      if (
        event.event === "templates.add.progress" &&
        isRecord(payload) &&
        requestId !== undefined &&
        payload.requestId === requestId &&
        (payload.stage === "agent-ready" || payload.stage === "agent-admitted") &&
        typeof payload.agentId === "string" &&
        typeof payload.sessionKey === "string"
      ) {
        const saved = { agentId: payload.agentId, sessionKey: payload.sessionKey };
        if (payload.stage === "agent-admitted") {
          durableAdmission(saved);
        } else {
          admit(saved);
        }
      }
    });
    try {
      const result = await applyTemplateAdd(client, source, {
        reviewPlan: plan,
        acknowledgeClawHubRisk,
        onSent: (id) => {
          requestId = id;
        },
      });
      if (!isCurrent()) {
        return;
      }
      if (result.agentId && (result.status === "complete" || result.agentRetained)) {
        if (result.sessionKey) {
          const saved = { agentId: result.agentId, sessionKey: result.sessionKey };
          if (result.initializationPending) {
            durableAdmission(saved);
          } else {
            admit(saved);
          }
        }
      }
      if (result.status !== "complete" || !creation.admitted) {
        throw new Error(result.error?.message ?? t("templatesCatalog.addFailed"));
      }
    } catch (error) {
      if (isCurrent()) {
        if (durable && !creation.admitted) {
          composer.error = formatUiError(error);
          composer.recovery = {
            error: composer.error,
            label: t("newSession.retrySetup"),
            pending: true,
            retry: () => {
              void apply();
            },
          };
        }
        if (!creation.admitted && !durable && ownsForeground() && initialRoute) {
          context.replace(initialRoute, initialLocation);
        }
        showToast({
          severity: creation.admitted || durable ? "warning" : "error",
          message: formatUiError(error),
          durationMs: 12_000,
        });
      }
    } finally {
      unsubscribe();
      pending.clear();
      if (!durable || creation.admitted || !isCurrent()) {
        clearChat();
      }
      composer.releaseDraft();
      applying = false;
      if (composer.recovery) {
        composer.recovery.pending = false;
        composer.notify();
      }
    }
  };
  await apply();
}
