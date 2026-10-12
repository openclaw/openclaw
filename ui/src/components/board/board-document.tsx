import {
  GATEWAY_SERVER_CAPS,
  type BoardGetParams,
  type BoardSnapshot,
} from "@openclaw/gateway-protocol";
import {
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  Show,
} from "solid-js";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorApprovalsAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
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
import { projectBoardProvider } from "../../lib/reactive/domain-board.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
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
  capabilityKey: string;
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
class BoardDocumentController {
  documentState: DashboardDocumentState = "loading";
  snapshot?: BoardSnapshot;
  activeTabId = "";
  errorText = "";
  private provider: BoardProvider | null = null;
  private providerLease: BoardProviderLease | null = null;
  private binding: (ProviderBinding & { session: BoardGetParams }) | null = null;
  private providerSubscriptions: (() => void)[] = [];
  private bindingGeneration = 0;

  constructor(
    private readonly props: BoardDocumentProps,
    private readonly notify: () => void,
  ) {}

  update(): void {
    this.synchronizeProvider();
    this.notify();
  }

  dispose(): void {
    this.releaseProvider();
  }

  private providerCapabilities(snapshot: ApplicationGatewaySnapshot) {
    const canMutate = hasOperatorWriteAccess(snapshot.hello?.auth ?? null);
    return {
      canMutate,
      canGrant: hasOperatorApprovalsAccess(snapshot.hello?.auth ?? null),
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

  private synchronizeProvider(): void {
    const sessionKey =
      (this.props.preparedSession?.sessionKey ?? this.props.sessionKey)?.trim() ?? "";
    if (!sessionKey) {
      this.releaseProvider();
      this.documentState = "missing-session";
      return;
    }
    const snapshot = this.props.gatewaySnapshot;
    const client = snapshot?.client;
    if (!snapshot || !client) {
      this.releaseProvider();
      this.documentState = "loading";
      return;
    }
    if (isGatewayMethodAdvertised(snapshot, "board.get") === false) {
      this.releaseProvider();
      this.documentState = "unavailable";
      return;
    }
    const capabilities = this.providerCapabilities(snapshot);
    const capabilityKey = JSON.stringify(capabilities);
    if (
      this.binding?.client === client &&
      this.binding.sessions === this.props.sessions &&
      this.binding.sessionKey === sessionKey &&
      (!this.props.preparedSession ||
        this.binding.session.agentId === this.props.preparedSession.agentId) &&
      this.binding.capabilityKey === capabilityKey
    ) {
      this.providerLease?.update(client, snapshot.phase === "connected", capabilities);
      return;
    }
    this.releaseProvider();
    this.documentState = "loading";
    const generation = this.bindingGeneration;
    void this.bindProvider(
      { client, sessions: this.props.sessions, sessionKey, capabilityKey },
      capabilities,
      generation,
      this.props.preparedSession ?? null,
    );
  }

  private async bindProvider(
    binding: ProviderBinding,
    capabilities: ReturnType<BoardDocumentController["providerCapabilities"]>,
    generation: number,
    preparedSession: BoardGetParams | null,
  ): Promise<void> {
    try {
      const sessions = binding.sessions;
      if (!preparedSession && !sessions) {
        this.documentState = "unavailable";
        this.notify();
        return;
      }
      const described =
        preparedSession || !sessions
          ? null
          : await sessions.describe({ key: binding.sessionKey }, { client: binding.client });
      if (generation !== this.bindingGeneration) {
        return;
      }
      if (!preparedSession && !described?.session) {
        this.documentState = "not-found";
        this.notify();
        return;
      }
      const current = this.props.gatewaySnapshot;
      if (!current || current.client !== binding.client) {
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
      );
      const provider = lease.provider;
      this.provider = provider;
      this.providerLease = lease;
      this.binding = { ...binding, session };
      const projection = projectBoardProvider(provider);
      this.providerSubscriptions.push(
        projection.subscribe(() => this.reconcileProvider(provider)),
        () => projection.dispose(),
      );
      this.providerSubscriptions.push(
        provider.events.subscribe(({ command }) => {
          if (
            command.kind === "focus_tab" &&
            provider.snapshot$.value.tabs.some((tab) => tab.tabId === command.tabId)
          ) {
            this.activeTabId = command.tabId;
            this.notify();
          }
        }),
      );
      this.reconcileProvider(provider);
    } catch (error) {
      if (generation === this.bindingGeneration) {
        this.errorText = formatUiError(error);
        this.documentState = "error";
        this.notify();
      }
    }
  }

  private selectAvailableTab(): void {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    if (snapshot.tabs.some((tab) => tab.tabId === this.activeTabId)) {
      return;
    }
    this.activeTabId = snapshot.tabs[0]?.tabId ?? snapshot.widgets[0]?.tabId ?? "";
  }

  private reconcileProvider(provider: BoardProvider): void {
    if (this.provider !== provider) {
      return;
    }
    if (provider.hasLoadedSnapshot) {
      this.snapshot = provider.snapshot$.value;
      this.selectAvailableTab();
      this.documentState = "ready";
      this.notify();
      return;
    }
    const loadError = provider.loadError$.value;
    if (loadError) {
      this.errorText = loadError;
      this.documentState = "error";
    } else {
      this.errorText = "";
      this.documentState = "loading";
    }
    this.notify();
  }

  private releaseProvider(): void {
    this.bindingGeneration += 1;
    for (const unsubscribe of this.providerSubscriptions) {
      unsubscribe();
    }
    this.providerSubscriptions = [];
    this.providerLease?.release();
    this.provider = null;
    this.providerLease = null;
    this.binding = null;
    this.snapshot = undefined;
    this.activeTabId = "";
    this.errorText = "";
  }

  presentation(passive: boolean) {
    const provider = this.provider;
    const snapshot = this.snapshot;
    const session = this.binding?.session;
    if (!provider || !snapshot || !session) {
      return undefined;
    }
    const callbacks = {
      appViewGeneration: provider.appViewGeneration,
      applyOps: (ops) => provider.applyOps(ops),
      grant: (name, decision) => provider.grant(name, decision),
      selectTab: (tabId) => {
        this.activeTabId = tabId;
        this.notify();
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
            isPassiveBoardWidget(
              widget,
              this.props.gatewaySnapshot?.hello?.controlUiWidgetKinds ?? [],
            ),
          ),
        }
      : snapshot;
    return {
      provider,
      widgetFrameUrl: (name: string, revision: number) => provider.widgetFrameUrl(name, revision),
      snapshot: renderSnapshot,
      session,
      callbacks,
      activeTabId: this.activeTabId,
    };
  }
}

function BoardDocumentContent(props: BoardDocumentProps) {
  const owner = getOwner();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const controller = new BoardDocumentController(props, () => setRevision((value) => value + 1));
  createEffect(
    () => ({
      gatewaySnapshot: props.gatewaySnapshot,
      sessions: props.sessions,
      sessionKey: props.sessionKey,
      preparedSession: props.preparedSession,
    }),
    () => runWithOwner(owner, () => controller.update()),
  );
  onCleanup(() => controller.dispose());
  const state = createMemo(() => {
    revision();
    return {
      kind: controller.documentState,
      error: controller.errorText,
      board: controller.presentation(props.passive ?? false),
    };
  });
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
