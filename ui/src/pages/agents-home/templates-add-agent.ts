import {
  isGatewayProtocolResponseError,
  readClawHubRiskAcknowledgementRequiredError,
} from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  selectNextTemplateAgentId,
  templateAgentCopyNumber,
} from "../../../../src/templates/add-agent-id.js";
import { toGatewayErrorInfo } from "../../api/gateway-connect-errors.ts";
import { pathForTemplateCatalogEntry, routeIdFromPath } from "../../app-route-paths.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { completeAgentCreation } from "../../lib/agents/creation-recovery.runtime.ts";
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
  type TemplateCatalogEntry,
  type TemplateCatalogSource,
} from "./templates-catalog-client.ts";

/** An Add the Gateway undid: nothing was kept, so its catalog card explains why. */
export type TemplateAddFailure = {
  entry: TemplateCatalogEntry;
  message: string;
  /** ClawHub flagged this release; adding it needs the user's acknowledgement. */
  trustWarning?: string;
};

// The catalog page that started an Add is gone once its chat opens. A failure
// waits here until a catalog page showing that Template accepts it.
type FailureReceiver = (failure: TemplateAddFailure) => boolean;
type FailureMailbox = { waiting?: TemplateAddFailure; receivers: Set<FailureReceiver> };
const failureMailboxes = new WeakMap<ApplicationContext, FailureMailbox>();

function failureMailbox(context: ApplicationContext): FailureMailbox {
  let mailbox = failureMailboxes.get(context);
  if (!mailbox) {
    mailbox = { receivers: new Set() };
    failureMailboxes.set(context, mailbox);
  }
  return mailbox;
}

/** `receive` answers whether its page shows the failed Template. */
export function receiveTemplateAddFailures(
  context: ApplicationContext,
  receive: FailureReceiver,
): () => void {
  const mailbox = failureMailbox(context);
  mailbox.receivers.add(receive);
  if (mailbox.waiting && receive(mailbox.waiting)) {
    mailbox.waiting = undefined;
  }
  return () => mailbox.receivers.delete(receive);
}

/** Like sidebar New agent, the application owns the handoff after its initiating page closes. */
export async function addTemplateAgent(
  context: ApplicationContext,
  template: {
    entry: TemplateCatalogEntry;
    source: TemplateCatalogSource;
    /** The declared id, or a presentation-only id while resolveAgent reads the release. */
    agentId: string;
    agentName?: string;
    resolveAgent?: () => Promise<{ agentId: string }>;
  },
  acknowledgeClawHubRisk: boolean,
) {
  const { source } = template;
  const client = context.gateway.snapshot.client;
  const scopeKey = gatewayPresentationScope(context.gateway).key;
  const isCurrent = () =>
    context.gateway.snapshot.client === client &&
    gatewayPresentationScope(context.gateway).key === scopeKey;
  if (!client) {
    throw new Error(t("templatesCatalog.addFailed"));
  }
  // Ask for an id this roster does not use, so the chat opened below is the new
  // agent's. The Gateway still chooses: on a stale roster it answers with another id
  // and the admitted chat replaces this route once it is ready.
  const agentId = selectNextTemplateAgentId(
    template.agentId,
    context.agents.state.agentsList?.agents.map((agent) => agent.id) ?? [],
  );
  const copy = templateAgentCopyNumber(template.agentId, agentId);
  const baseName = template.agentName ?? template.entry.displayName;
  const name = copy > 1 ? `${baseName} ${copy}` : baseName;
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
  // A retry continues the agent the Gateway admitted, whatever id it chose.
  let requestAgentId = agentId;
  let resolveAgent = template.resolveAgent;
  const target = sessionNavigationTarget({
    context,
    face: "chat",
    sessionKey: creation.sessionKey,
    agentId,
    exactKey: true,
  });
  const composer = new CreationComposer(
    context,
    agentId,
    false,
    () => {},
    () => clearChat(),
  );
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
    requestAgentId = saved.agentId;
    composer.accept(
      { key: saved.sessionKey, initialRun: { status: "idle" } },
      { initializationPending: true },
    );
    retainCreatedComposer(context, saved.sessionKey, composer);
    completeAgentCreation(context.agents.state, pending, { id: saved.agentId, name });
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
    completeAgentCreation(context.agents.state, pending, { id: ready.agentId, name });
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
      (durable &&
        (!composer.canDisplay() ||
          context.chatSubmissions.creationFor(creation.sessionKey) !== creation))
    ) {
      return;
    }
    applying = true;
    const retry = durable;
    if (composer.recovery) {
      composer.recovery.pending = true;
      composer.error = null;
      composer.notify();
    }
    let requestId: string | undefined;
    let requestStarted = false;
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
      // A cold catalog card has no declared id yet. Its pending chat is already
      // visible; only the mutation waits for the release identity. Never submit
      // the presentation-only id to the Gateway.
      if (resolveAgent) {
        let connected = context.gateway.snapshot.phase === "connected";
        const stop = context.gateway.subscribe((snapshot) => {
          connected &&= snapshot.phase === "connected" && isCurrent();
        });
        let identity: { agentId: string };
        try {
          identity = await resolveAgent();
        } finally {
          stop();
        }
        if (!isCurrent()) {
          return;
        }
        if (!connected) {
          throw new Error(t("templatesCatalog.addFailed"));
        }
        requestAgentId = selectNextTemplateAgentId(
          identity.agentId,
          context.agents.state.agentsList?.agents.map((agent) => agent.id) ?? [],
        );
        resolveAgent = undefined;
      }
      requestStarted = true;
      const result = await applyTemplateAdd(client, source, {
        agentId: requestAgentId,
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
      // A first request answered with an error kept nothing: the Gateway removed the
      // agent and chat it had admitted. A lost connection or a retry proves no such thing.
      if (
        isCurrent() &&
        !retry &&
        !creation.admitted &&
        (!requestStarted || isGatewayProtocolResponseError(error))
      ) {
        const foreground = ownsForeground();
        const admitted = durable;
        durable = false;
        composer.dispose();
        if (admitted) {
          void context.agents.refreshList();
        }
        const trustWarning =
          !acknowledgeClawHubRisk && isGatewayProtocolResponseError(error)
            ? readClawHubRiskAcknowledgementRequiredError(toGatewayErrorInfo(error))?.warning
            : undefined;
        const failure: TemplateAddFailure = {
          entry: template.entry,
          message: formatUiError(error),
          ...(trustWarning ? { trustWarning } : {}),
        };
        if (foreground) {
          const mailbox = failureMailbox(context);
          const shown = [...mailbox.receivers].filter((receive) => receive(failure));
          mailbox.waiting = shown.length > 0 ? undefined : failure;
          // Back to the catalog page Add was clicked on. An Add started elsewhere, from
          // a Template link in a chat, returns to that Template's own catalog page.
          context.replace(
            "templates",
            initialRoute === "templates"
              ? initialLocation
              : {
                  pathname: pathForTemplateCatalogEntry(source.packageName, context.basePath),
                  search: `?${new URLSearchParams({ version: source.version })}`,
                  hash: "",
                },
          );
        } else {
          showToast({ severity: "error", message: failure.message, durationMs: 12_000 });
        }
      } else if (isCurrent()) {
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
