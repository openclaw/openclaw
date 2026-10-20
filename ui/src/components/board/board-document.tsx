import type { BoardGetParams, BoardSnapshot } from "@openclaw/gateway-protocol";
import { createMemo, onSettled, Show } from "solid-js";
import { GATEWAY_SERVER_CAPS } from "../../../../packages/gateway-protocol/src/server-capabilities.js";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import {
  hasOperatorApprovalsAccess,
  hasOperatorReadAccess,
  hasOperatorWriteAccess,
} from "../../app/operator-access.ts";
import {
  acquireBoardProviderForSession,
  type BoardProvider,
  type BoardProviderLease,
} from "../../lib/board/provider.ts";
import type { BoardViewCallbacks } from "../../lib/board/view-types.ts";
import { isPassiveBoardWidget } from "../../lib/board/widgets/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  isGatewayCapabilityAdvertised,
  isGatewayMethodAdvertised,
} from "../../lib/gateway-methods.ts";
import { projectCallbackOwner } from "../../lib/reactive/callback-owner.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { Icon } from "../solid/icon.tsx";
import { PanelLoadingSkeleton } from "../solid/panel-loading-skeleton.tsx";
import "../../styles/board-document.css";
import { BoardView } from "./board-view.tsx";

type DashboardDocumentState =
  | "loading"
  | "ready"
  | "missing-session"
  | "not-found"
  | "unavailable"
  | "error";

type ProviderBinding = {
  client: NonNullable<ApplicationGatewaySnapshot["client"]>;
  sessions?: Pick<SessionCapability, "describe">;
  sessionKey: string;
  presentationScope?: object;
};

export type BoardDocumentProps = {
  gatewaySnapshot?: ApplicationGatewaySnapshot;
  sessions?: Pick<SessionCapability, "describe">;
  sessionKey?: string | null;
  preparedSession?: BoardGetParams | null;
  onDocumentClose?: (() => void) | null;
  passive?: boolean;
};

// The provider binding remains synchronous; Solid observes its presentation facts.
function createBoardDocument(
  props: BoardDocumentProps,
  readPresentationScope: () => object | undefined,
  notify: () => void,
) {
  let documentState: DashboardDocumentState = "loading";
  let ownedSnapshot: BoardSnapshot | undefined;
  let activeTabId = "";
  let errorText = "";
  let ownedProvider: BoardProvider | null = null;
  let providerLease: BoardProviderLease | null = null;
  let ownedBinding: (ProviderBinding & { session: BoardGetParams }) | null = null;
  let providerSubscriptions: (() => void)[] = [];
  let bindingGeneration = 0;

  function update(): void {
    synchronizeProvider();
    notify();
  }

  function providerCapabilities(snapshot: ApplicationGatewaySnapshot) {
    const connected = snapshot.phase === "connected";
    const canMutate = connected && hasOperatorWriteAccess(snapshot.hello?.auth ?? null);
    return {
      canMutate,
      canGrant: connected && hasOperatorApprovalsAccess(snapshot.hello?.auth ?? null),
      canPinWidgets:
        canMutate &&
        isGatewayCapabilityAdvertised(snapshot, GATEWAY_SERVER_CAPS.BOARD_WIDGET_PUT_CANVAS_DOC) ===
          true,
      canPinMcpApps:
        canMutate &&
        isGatewayMethodAdvertised(snapshot, "board.widget.appView") === true &&
        isGatewayMethodAdvertised(snapshot, "board.widget.put") === true,
    };
  }

  function synchronizeProvider(): void {
    const presentationScope = readPresentationScope();
    const sessionKey = (props.preparedSession?.sessionKey ?? props.sessionKey)?.trim() ?? "";
    if (!sessionKey) {
      releaseProvider();
      documentState = "missing-session";
      return;
    }
    const snapshot = props.gatewaySnapshot;
    const client = snapshot?.client;
    if (!snapshot || !client) {
      releaseProvider();
      documentState = "loading";
      return;
    }
    if (
      snapshot.phase === "connected" &&
      (!hasOperatorReadAccess(snapshot.hello?.auth ?? null) ||
        isGatewayMethodAdvertised(snapshot, "board.get") === false)
    ) {
      releaseProvider();
      documentState = "unavailable";
      return;
    }
    const capabilities = providerCapabilities(snapshot);
    if (
      ownedBinding?.client === client &&
      ownedBinding.presentationScope === presentationScope &&
      ownedBinding.sessions === props.sessions &&
      ownedBinding.sessionKey === sessionKey &&
      (!props.preparedSession || ownedBinding.session.agentId === props.preparedSession.agentId)
    ) {
      providerLease?.update(client, snapshot.phase === "connected", capabilities);
      return;
    }
    releaseProvider();
    documentState = "loading";
    if (snapshot.phase !== "connected") {
      return;
    }
    const generation = bindingGeneration;
    void bindProvider(
      { client, sessions: props.sessions, sessionKey, presentationScope },
      capabilities,
      generation,
      props.preparedSession ?? null,
    );
  }

  async function bindProvider(
    binding: ProviderBinding,
    capabilities: ReturnType<typeof providerCapabilities>,
    generation: number,
    preparedSession: BoardGetParams | null,
  ): Promise<void> {
    try {
      const sessions = binding.sessions;
      if (!preparedSession && !sessions) {
        documentState = "unavailable";
        notify();
        return;
      }
      const described =
        preparedSession || !sessions
          ? null
          : await sessions.describe({ key: binding.sessionKey }, { client: binding.client });
      if (generation !== bindingGeneration) {
        return;
      }
      if (!preparedSession && !described?.session) {
        documentState = "not-found";
        notify();
        return;
      }
      const current = props.gatewaySnapshot;
      if (
        !current ||
        current.client !== binding.client ||
        readPresentationScope() !== binding.presentationScope
      ) {
        return;
      }
      const session = preparedSession ?? {
        sessionKey: described!.session!.key,
        agentId: described!.session!.agentId,
      };
      const lease = acquireBoardProviderForSession(
        session,
        binding.client,
        current.phase === "connected",
        capabilities.canPinWidgets,
        capabilities.canPinMcpApps,
        capabilities.canMutate,
        capabilities.canGrant,
        binding.presentationScope,
      );
      const provider = lease.provider;
      ownedProvider = provider;
      providerLease = lease;
      ownedBinding = { ...binding, session };
      // Reconcile tab intent from provider receipts and preserve ordered focus commands.
      providerSubscriptions.push(
        provider.snapshot$.subscribe(() => reconcileProvider(provider)),
        provider.loadError$.subscribe(() => reconcileProvider(provider)),
        provider.events.subscribe(({ command }) => {
          if (
            command.kind === "focus_tab" &&
            provider.snapshot$.value.tabs.some((tab) => tab.tabId === command.tabId)
          ) {
            activeTabId = command.tabId;
            notify();
          }
        }),
      );
      reconcileProvider(provider);
    } catch (error) {
      if (generation === bindingGeneration) {
        errorText = formatUiError(error);
        documentState = "error";
        notify();
      }
    }
  }

  function reconcileProvider(provider: BoardProvider): void {
    if (ownedProvider !== provider) {
      return;
    }
    if (provider.hasLoadedSnapshot) {
      const snapshot = provider.snapshot$.value;
      ownedSnapshot = snapshot;
      if (!snapshot.tabs.some((tab) => tab.tabId === activeTabId)) {
        activeTabId = snapshot.tabs[0]?.tabId ?? snapshot.widgets[0]?.tabId ?? "";
      }
      documentState = "ready";
      notify();
      return;
    }
    const loadError = provider.loadError$.value;
    if (loadError) {
      errorText = loadError;
      documentState = "error";
    } else {
      errorText = "";
      documentState = "loading";
    }
    notify();
  }

  function releaseProvider(): void {
    bindingGeneration += 1;
    for (const unsubscribe of providerSubscriptions) {
      unsubscribe();
    }
    providerSubscriptions = [];
    providerLease?.release();
    ownedProvider = null;
    providerLease = null;
    ownedBinding = null;
    ownedSnapshot = undefined;
    activeTabId = "";
    errorText = "";
  }

  function presentation(passive: boolean) {
    const provider = ownedProvider;
    const snapshot = ownedSnapshot;
    const session = ownedBinding?.session;
    if (!provider || !snapshot || !session) {
      return undefined;
    }
    const callbacks = {
      appViewGeneration: provider.appViewGeneration,
      applyOps: (ops) => provider.applyOps(ops),
      grant: (name, decision) => provider.grant(name, decision),
      selectTab: (tabId) => {
        activeTabId = tabId;
        notify();
      },
      frameLoadFailed: (name) => provider.refreshWidgetFrame(name),
      ...(!passive
        ? {
            widgetAppView: (name, revision) => provider.widgetAppView(name, revision),
            refreshWidgetAppView: (name, revision) => provider.refreshWidgetAppView(name, revision),
          }
        : {}),
    } satisfies BoardViewCallbacks;
    // Previews admit only saved HTML and declared pure core widgets.
    const renderSnapshot = passive
      ? {
          ...snapshot,
          widgets: snapshot.widgets.filter((widget) =>
            isPassiveBoardWidget(widget, props.gatewaySnapshot?.hello?.controlUiWidgetKinds ?? []),
          ),
        }
      : snapshot;
    return {
      provider,
      widgetFrameUrl: (name: string, revision: number) => provider.widgetFrameUrl(name, revision),
      snapshot: renderSnapshot,
      session,
      callbacks,
      activeTabId,
    };
  }
  return {
    update,
    dispose: releaseProvider,
    read: (passive: boolean) => ({
      kind: documentState,
      error: errorText,
      board: presentation(passive),
    }),
  };
}

const inputUpdates = new WeakMap<HTMLElement, () => void>();

function BoardDocumentContent(
  props: BoardDocumentProps,
  host: SolidBridgeElement<BoardDocumentProps>,
) {
  const context = useOptionalApplication();
  const readPresentationScope = () =>
    context ? gatewayPresentationScope(context.gateway) : undefined;
  const { owner: document, view: projection } = projectCallbackOwner(
    (notify) => createBoardDocument(host, readPresentationScope, notify),
    (current) => current,
  );
  onSettled(() => {
    let active = true;
    let pending = false;
    const scheduleUpdate = () => {
      if (pending) {
        return;
      }
      pending = true;
      onSettled(() => {
        pending = false;
        if (active) {
          document.update();
        }
      });
    };
    inputUpdates.set(host, scheduleUpdate);
    // Gateway receipts rebind the provider lease and its admitted capabilities after settlement.
    const unsubscribeGateway = context?.gateway.subscribe(scheduleUpdate);
    document.update();
    return () => {
      active = false;
      inputUpdates.delete(host);
      unsubscribeGateway?.();
      document.dispose();
    };
  });
  const state = createMemo(() => projection.read().read(props.passive ?? false));
  const statusText = () =>
    state().kind === "missing-session"
      ? t("dashboardDocument.missingSession")
      : state().kind === "not-found"
        ? t("dashboardDocument.notFound")
        : t("dashboardDocument.unavailable");
  return (
    <main class="board-document" aria-label={t("board.label")}>
      {props.onDocumentClose ? (
        <button
          class="btn btn--ghost btn--icon board-document__close"
          type="button"
          aria-label={t("dashboardDocument.close")}
          title={t("dashboardDocument.close")}
          onClick={() => props.onDocumentClose?.()}
        >
          <Icon name="x" />
        </button>
      ) : null}
      <div class="board-document__content">
        <Show when={state().kind === "loading"}>
          <PanelLoadingSkeleton variant="board" label={t("common.loading")} />
        </Show>
        <Show when={state().kind === "error"}>
          <div class="board-document__state board-document__state--error" role="alert">
            {t("dashboardDocument.loadFailed", { error: state().error })}
          </div>
        </Show>
        <Show when={["missing-session", "not-found", "unavailable"].includes(state().kind)}>
          <div class="board-document__state" role="status">
            {statusText()}
          </div>
        </Show>
        <Show when={state().kind === "ready" && state().board}>
          {(board) => (
            <BoardView
              active={true}
              bridgeEnabled={!props.passive}
              fitAutoContent={true}
              session={board().session}
              snapshot={board().snapshot}
              activeTabId={board().activeTabId}
              widgetFrameUrl={board().widgetFrameUrl}
              callbacks={board().callbacks}
              canMutate={!props.passive && board().provider.canMutate}
              canGrant={!props.passive && board().provider.canGrant}
            />
          )}
        </Show>
      </div>
    </main>
  );
}

export const OpenClawBoardDocument = defineSolidBridge<BoardDocumentProps>(
  "openclaw-board-document",
  BoardDocumentContent,
  {
    propertyChanged: (host, key) => {
      if (
        key === "gatewaySnapshot" ||
        key === "sessions" ||
        key === "sessionKey" ||
        key === "preparedSession"
      ) {
        inputUpdates.get(host)?.();
      }
    },
    properties: {
      gatewaySnapshot: { default: undefined, attribute: false },
      sessions: { default: undefined, attribute: false },
      sessionKey: { default: null, attribute: false },
      preparedSession: { default: null, attribute: false },
      onDocumentClose: { default: null, attribute: false },
      passive: { default: false, type: Boolean },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-board-document": SolidBridgeElement<BoardDocumentProps>;
  }
}
