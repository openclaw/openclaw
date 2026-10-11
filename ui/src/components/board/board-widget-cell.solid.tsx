import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { ContextNotFoundError, createErrorBoundary } from "@solidjs/signals";
import { dynamic, type JSX as SolidJSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
  Show,
  Switch,
  Match,
  untrack,
} from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import {
  ensureCustomElementDefined,
  isOptionalElementDefined,
  LazyCustomElementRequestController,
} from "../../app/lazy-custom-element.ts";
import {
  BOARD_DOCUMENT_AUTO_MAX_ROWS,
  boardChromeRowPx,
  exactBoardWidgetHeightPx,
} from "../../lib/board/grid.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import {
  CORE_BOARD_WIDGET_ELEMENTS,
  getPluginWidgetKindContribution,
  pluginIdForWidgetKind,
} from "../../lib/board/widgets/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { showToast } from "../../lib/toast.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { CustomPluginUiDisabled } from "../../plugins/control-ui-disabled.solid.tsx";
import { PluginContribution } from "../../plugins/control-ui-view.solid.tsx";
import { LazyViewError } from "../solid/lazy-view-error.tsx";
import { BoardMcpAppContent } from "./board-mcp-app-content.tsx";
import { BoardMcpAppLifecycle } from "./board-mcp-app-lifecycle.ts";
import {
  BoardGrantedCapabilities,
  BoardPendingCapabilities,
} from "./board-widget-capabilities.solid.tsx";
import {
  BOARD_SIZE_PRESETS,
  closeBoardWidgetMenu,
  type BoardWidgetCellHandle,
  type BoardWidgetCellMethods,
  type BoardWidgetCellProps,
} from "./board-widget-cell-options.ts";
import {
  BoardDisabledPlugin,
  BoardWidgetError,
  BoardWidgetMenu,
  BoardWidgetRejected,
} from "./board-widget-cell-render.solid.tsx";
import { BoardWidgetFrameLifecycle } from "./board-widget-frame.tsx";
import "../web-awesome.ts";

const loadMcpAppView = () => import("../mcp-app-view-registration.ts");
const cells = new WeakMap<HTMLElement, BoardWidgetCellHandle>();

function BoardWidgetCellContent(
  props: BoardWidgetCellProps,
  host: SolidBridgeElement<BoardWidgetCellProps, BoardWidgetCellMethods>,
) {
  let context: ApplicationContext | undefined;
  try {
    context = useApplication();
  } catch (error) {
    // Standalone capless cells have no application provider.
    if (!(error instanceof ContextNotFoundError)) {
      throw error;
    }
  }
  Object.defineProperty(host, "presentationReady", {
    configurable: true,
    get: () => cells.get(host)?.presentationReady ?? false,
  });
  onCleanup(() => cells.delete(host));
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const requestUpdate = () => {
    if (connected) {
      setRevision((value) => value + 1);
    }
  };
  let actionError = "";
  let actionPending = false;
  let bodyErrored = false;
  let resetBodyError: (() => void) | undefined;
  let connected = true;
  const [renderedMcp, setRenderedMcp] = createSignal(
    untrack(() => props.widget?.contentKind === "mcp-app"),
    { ownedWrite: true },
  );
  const active = () => props.active !== false;
  const canMutate = () => props.canMutate !== false;
  const canGrant = () => props.canGrant !== false;
  const plugins = projectSource(context?.plugins, {
    read: (runtime) => runtime,
    subscribe: (runtime, notify) => runtime?.subscribe(notify) ?? (() => {}),
    equality: "revision",
  });
  const gateway = projectSource(context?.gateway, {
    read: (owner) => owner?.snapshot,
    subscribe: (owner, notify) => owner?.subscribe?.(notify) ?? (() => {}),
    equality: "revision",
  });
  const loader = new LazyCustomElementRequestController({ requestUpdate });
  const loadError = () => {
    revision();
    const value = loader.visibleState;
    return value?.status === "error" ? value : undefined;
  };
  const appView = new BoardMcpAppLifecycle({
    active: () => untrack(active),
    connected: () => connected,
    requestUpdate,
    sessionKey: () => untrack(() => props.sessionKey ?? ""),
    widget: () => untrack(() => props.widget),
  });
  const frame = new BoardWidgetFrameLifecycle({
    active: () => untrack(active),
    connected: () => connected,
    loadingCovered: () => untrack(() => props.loadingCovered ?? false),
    bridgeEnabled: () => untrack(() => props.bridgeEnabled !== false),
    context: () => context,
    refreshFrame: () => untrack(() => props.callbacks?.frameLoadFailed),
    reportContentHeight: (name, height) =>
      untrack(() => props.callbacks?.reportContentHeight(name, height)),
    scrollBy: (deltaY) =>
      host.closest("openclaw-board-view")?.scrollBy({ top: deltaY, behavior: "auto" }),
    requestUpdate,
    resolveFrameUrl: () => untrack(() => props.widgetFrameUrl),
    root: () => host,
    widget: () => untrack(() => props.widget),
  });
  const state = createMemo(() => {
    revision();
    return {
      error: actionError,
      pending: actionPending,
      frameError: frame.error,
      appView: appView.state,
      loading: appView.loading,
      nearVisible: appView.nearVisible,
    };
  });
  const activeKinds = () => gateway.read()?.hello?.controlUiWidgetKinds ?? [];
  const contribution = () =>
    props.widget?.contentKind === "plugin" && !props.widget.frameUrl
      ? getPluginWidgetKindContribution(props.widget.pluginKind, activeKinds())
      : null;
  const CoreElement = dynamic(() => contribution()?.tagName);
  const CoreWidget = () => {
    let element!: HTMLElement & {
      widget?: BoardWidget;
      session?: BoardGetParams;
      active?: boolean;
    };
    createEffect(
      () => ({ widget: props.widget, session: props.session, active: active() }),
      (value) => {
        element.widget = value.widget;
        element.session = value.session ?? { sessionKey: "" };
        element.active = value.active;
      },
    );
    return (
      <CoreElement
        ref={(node: typeof element) => {
          element = node;
        }}
      />
    );
  };

  async function runAction(action: () => Promise<void>, failureMessage?: string) {
    if (actionPending || props.busy) {
      return;
    }
    actionPending = true;
    actionError = "";
    requestUpdate();
    closeBoardWidgetMenu(host);
    try {
      await action();
    } catch (error) {
      actionError = formatUiError(error);
      if (failureMessage) {
        showToast({ message: failureMessage });
      }
    } finally {
      actionPending = false;
      requestUpdate();
    }
  }
  function selectMenuItem(value: string | undefined) {
    const widget = props.widget;
    const callbacks = props.callbacks;
    if (!widget || !callbacks || !active() || !canMutate()) {
      return;
    }
    if (value === "remove") {
      void runAction(() => callbacks.remove(widget));
    } else if (value?.startsWith("move:")) {
      void runAction(() => callbacks.moveToTab(widget, value.slice(5)));
    } else if (value?.startsWith("resize:")) {
      const size = Object.entries(BOARD_SIZE_PRESETS).find(
        ([preset]) => preset === value.slice(7),
      )?.[1];
      if (size) {
        void runAction(() => callbacks.resizeTo(widget, size.w, size.h));
      }
    } else if (value === "height:auto") {
      void runAction(() =>
        callbacks.setHeightMode(widget, widget.heightMode !== "fixed" ? "fixed" : "auto"),
      );
    }
  }
  const presentationReady = () =>
    !props.widget?.viewTicket ||
    props.widget.grantState === "pending" ||
    props.widget.grantState === "rejected" ||
    bodyErrored ||
    frame.presentationReady;
  cells.set(host, {
    get presentationReady() {
      return untrack(presentationReady);
    },
    selectMenuItem,
    async teardown() {
      await host
        .querySelector<HTMLElement & { teardown?: () => Promise<void> }>("mcp-app-view")
        ?.teardown?.();
    },
    restartAfterTeardown() {
      host
        .querySelector<HTMLElement & { restartAfterTeardown?: () => void }>("mcp-app-view")
        ?.restartAfterTeardown?.();
    },
  });
  let previousWidget = untrack(() => props.widget);
  let previousBoardRevision = untrack(() => props.boardRevision);
  createEffect(
    () =>
      [
        props.widget,
        props.boardRevision,
        props.callbacks,
        props.sessionKey,
        active(),
        contribution(),
        gateway.read(),
      ] as const,
    () =>
      untrack(() => {
        if (previousBoardRevision !== props.boardRevision) {
          actionError = "";
        }
        previousBoardRevision = props.boardRevision;
        if (previousWidget && previousWidget !== props.widget) {
          if (
            previousWidget.name !== props.widget?.name ||
            previousWidget.instanceId !== props.widget?.instanceId ||
            previousWidget.revision !== props.widget?.revision
          ) {
            actionError = "";
          }
          frame.widgetChanged(previousWidget, props.widget);
          requestUpdate();
        }
        previousWidget = props.widget;
        appView.update(props.widget, props.callbacks);
        appView.activityChanged();
        frame.activityChanged();
        for (const element of CORE_BOARD_WIDGET_ELEMENTS) {
          loader.requestWhileActive(element, active() && contribution() === element);
        }
        if (props.widget?.contentKind === "mcp-app") {
          void ensureCustomElementDefined("mcp-app-view", loadMcpAppView).catch(() => undefined);
        }
        requestUpdate();
      }),
  );
  createEffect(
    () => [revision(), props.widget, active(), props.loadingCovered, props.bridgeEnabled] as const,
    () =>
      untrack(() => {
        appView.observe(
          host.querySelector(".board-widget"),
          active() && props.widget?.contentKind === "mcp-app",
        );
        queueMicrotask(() => {
          if (connected) {
            appView.sync();
          }
        });
        frame.update();
        if (props.loadingCovered && presentationReady()) {
          host.dispatchEvent(new Event("openclaw-board-widget-presentation", { bubbles: true }));
        }
      }),
  );
  createEffect(
    () => props.widget?.contentKind,
    (kind) => {
      if (kind === "mcp-app") {
        setRenderedMcp(true);
      } else if (!host.querySelector("mcp-app-view")) {
        setRenderedMcp(false);
      }
    },
  );
  let observedErrorBinding = false;
  createEffect(
    () => [props.widget, props.widgetFrameUrl, plugins.revision(), gateway.revision()] as const,
    () => {
      // The first observation belongs to the initial render, including its error fallback.
      if (observedErrorBinding && bodyErrored) {
        bodyErrored = false;
        resetBodyError?.();
      }
      observedErrorBinding = true;
    },
  );
  onSettled(() => {
    frame.connect();
    requestUpdate();
  });
  onCleanup(() => {
    connected = false;
    for (const element of CORE_BOARD_WIDGET_ELEMENTS) {
      loader.requestWhileActive(element, false);
    }
    appView.disconnect();
    frame.disconnect();
  });
  const unavailable = () => props.busy || state().pending || !canMutate();
  const AccessNotice = () => (
    <Show
      when={props.widget?.grantState === "pending"}
      fallback={
        <Show when={props.widget?.grantState === "rejected"}>
          <BoardWidgetRejected
            disabled={unavailable()}
            onRemove={() => void runAction(() => props.callbacks!.remove(props.widget!))}
          />
        </Show>
      }
    >
      <BoardPendingCapabilities
        widget={props.widget!}
        disabled={props.busy || state().pending || !canGrant()}
        onGrant={(decision) =>
          void runAction(
            () => props.callbacks!.grant(props.widget!.name, decision),
            t(decision === "granted" ? "board.widget.allowFailed" : "board.widget.rejectFailed"),
          )
        }
        error={
          <Show when={state().error}>
            <BoardWidgetError error={state().error} action inline />
          </Show>
        }
      />
    </Show>
  );
  const Frame = () => frame.render(() => props.widget!, revision);
  const Plugin = () => {
    const pluginId = () => pluginIdForWidgetKind(props.widget?.pluginKind);
    const key = () => `${pluginId()}/${props.widget?.pluginKind?.slice(pluginId().length + 1)}`;
    const advertised = () =>
      activeKinds().some(
        (entry) => entry.kind === props.widget?.pluginKind && entry.pluginId === pluginId(),
      );
    const native = () =>
      advertised() &&
      plugins
        .read()
        ?.registrations("widgets")
        .some((entry) => entry.key === key());
    const disabled = () =>
      plugins
        .read()
        ?.errors.some(
          (entry) => entry.pluginId === pluginId() && entry.code === "custom-plugin-ui-disabled",
        );
    const runtimeError = () =>
      !disabled() && advertised()
        ? plugins
            .read()
            ?.errors.find((entry) => entry.pluginId === pluginId() || entry.pluginId === "host")
        : undefined;
    const Loading = () => (
      <p class="board-widget__plugin-loading">{t("board.widget.pluginLoading")}</p>
    );
    return (
      <Switch
        fallback={
          <BoardDisabledPlugin
            pluginId={pluginId()}
            disabled={unavailable()}
            onRemove={() => void runAction(() => props.callbacks!.remove(props.widget!))}
          >
            <Show
              when={disabled()}
              fallback={
                <strong>{t("board.widget.disabledPlugin", { pluginId: pluginId() })}</strong>
              }
            >
              <CustomPluginUiDisabled context={context} pluginId={pluginId()} />
            </Show>
          </BoardDisabledPlugin>
        }
      >
        <Match when={contribution()}>
          <Show
            when={loadError()}
            fallback={
              <Show
                when={(revision(), isOptionalElementDefined(contribution()!))}
                fallback={<Loading />}
              >
                <CoreWidget />
              </Show>
            }
          >
            {(error) => (
              <LazyViewError
                error={error().error}
                stale={error().stale}
                subtitle={error().element.label}
                onRetry={() => loader.retry()}
              />
            )}
          </Show>
        </Match>
        <Match when={native()}>
          <PluginContribution
            kind="widgets"
            contributionKey={key()}
            props={{
              ...(props.session ?? { sessionKey: "" }),
              widget: { name: props.widget!.name, props: props.widget!.props },
              canMutate: canMutate(),
              canGrant: canGrant(),
            }}
            presented={active()}
          />
        </Match>
        <Match
          when={
            (context && gateway.read()?.phase !== "connected") ||
            plugins.read()?.isLoading(pluginId())
          }
        >
          <Loading />
        </Match>
        <Match when={runtimeError()}>
          <BoardWidgetError
            error={runtimeError()?.message}
            onRetry={() => void plugins.read()?.refresh()}
          />
        </Match>
      </Switch>
    );
  };
  const Body = () => (
    <Switch fallback={<Frame />}>
      <Match when={state().frameError}>
        <BoardWidgetError error={state().frameError} />
      </Match>
      <Match when={renderedMcp()}>
        <BoardMcpAppContent
          accessNotice={<AccessNotice />}
          active={active()}
          appView={state().appView}
          busy={unavailable()}
          loading={state().loading}
          nearVisible={state().nearVisible}
          sessionKey={props.sessionKey ?? ""}
          widget={props.widget!}
          expired={() => appView.expire()}
          remove={() => void runAction(() => props.callbacks!.remove(props.widget!))}
          retry={() => appView.retry()}
          retired={() => {
            if (props.widget?.contentKind !== "mcp-app") {
              setRenderedMcp(false);
            }
          }}
        />
      </Match>
      <Match
        when={props.widget?.grantState === "pending" || props.widget?.grantState === "rejected"}
      >
        <AccessNotice />
      </Match>
      <Match when={props.widget?.contentKind === "plugin" && !props.widget.frameUrl}>
        <Plugin />
      </Match>
    </Switch>
  );

  const presentation = () =>
    props.widget?.contentKind === "html" || props.widget?.frameUrl
      ? (props.widget.presentation ?? "card")
      : undefined;
  const label = () => props.widget?.title || props.widget?.name || "";
  const scrollable = () =>
    Boolean(
      bodyErrored ||
      state().error ||
      props.widget?.grantState === "pending" ||
      props.widget?.grantState === "rejected" ||
      props.widget?.contentKind === "mcp-app" ||
      (props.widget?.contentKind === "plugin" && !props.widget.frameUrl),
    );
  const style = (): SolidJSX.CSSProperties => {
    const rect = props.rect!;
    const height =
      props.dragging || props.pageChrome
        ? undefined
        : exactBoardWidgetHeightPx(
            props.widget!,
            props.contentHeightPx,
            boardChromeRowPx(),
            props.fitAutoContent ? BOARD_DOCUMENT_AUTO_MAX_ROWS : undefined,
          );
    return {
      "grid-column": `${rect.x + 1} / span ${rect.w}`,
      "grid-row": `${rect.y + 1} / span ${rect.h}`,
      "--board-widget-rows": rect.h,
      "--board-widget-order": props.positionInSet ?? 1,
      height:
        height === undefined
          ? undefined
          : `calc(${height}px - var(--board-widget-height-trim, 0px))`,
      "align-self": height === undefined ? undefined : "start",
    };
  };
  function keyDown(event: KeyboardEvent) {
    if (event.target !== event.currentTarget || !canMutate() || props.pageChrome) {
      return;
    }
    const direction =
      event.key === "ArrowLeft"
        ? "left"
        : event.key === "ArrowRight"
          ? "right"
          : event.key === "ArrowUp"
            ? "up"
            : event.key === "ArrowDown"
              ? "down"
              : null;
    if (!direction) {
      return;
    }
    event.preventDefault();
    if (event.altKey) {
      void runAction(() => props.callbacks!.nudge(props.widget!, direction));
    } else {
      props.callbacks!.focus(props.widget!, direction);
    }
  }
  return (
    <Show when={props.widget && props.rect && props.callbacks}>
      <section
        class={[
          "board-widget",
          {
            "board-widget--page-chrome": props.pageChrome,
            "board-widget--dragging": props.dragging,
          },
          presentation() && `board-widget--${presentation()}`,
        ]}
        style={style()}
        role="listitem"
        tabindex={props.focusTabIndex ?? -1}
        aria-posinset={props.positionInSet ?? 1}
        aria-setsize={props.setSize ?? 1}
        aria-label={
          !canMutate() || props.pageChrome
            ? label()
            : t("board.widget.cellLabel", { title: label() })
        }
        data-widget-name={props.widget!.name}
        data-test-id="board-widget"
        onFocus={() => props.callbacks!.focusChanged(props.widget!.name)}
        onKeyDown={keyDown}
      >
        <Show when={!props.pageChrome}>
          <header class="board-widget__bar">
            <Show when={canMutate()}>
              <span
                class="board-widget__drag-handle"
                aria-hidden="true"
                title={t("board.widget.moveHandle", { title: label() })}
                onPointerDown={(event) => props.callbacks!.movePointerDown(props.widget!, event)}
              >
                <span aria-hidden="true">⠿</span>
              </span>
            </Show>
            <span class="board-widget__title" title={label()}>
              {label()}
            </span>
            <span class="board-widget__kind">
              {props.widget!.contentKind === "mcp-app"
                ? t("board.widget.kindMcp")
                : props.widget!.contentKind === "plugin"
                  ? props.widget!.kindLabel || contribution()?.label || t("board.widget.kindPlugin")
                  : t("board.widget.kindHtml")}
            </span>
            <BoardGrantedCapabilities widget={props.widget!} />
            <Show when={canMutate()}>
              <BoardWidgetMenu
                widget={props.widget!}
                tabs={props.tabs ?? []}
                disabled={props.busy || state().pending}
                onSelect={(event) => selectMenuItem(event.detail.item.value)}
              />
            </Show>
          </header>
        </Show>
        <div
          class={[
            "board-widget__body",
            {
              "board-widget__body--scrollable": scrollable(),
              "board-widget__body--card": presentation() === "card",
            },
          ]}
        >
          {createErrorBoundary(
            () => (
              <Body />
            ),
            (error, reset) => {
              resetBodyError = reset;
              bodyErrored = true;
              requestUpdate();
              return <BoardWidgetError error={error()} />;
            },
          )}
          <Show when={state().error && props.widget!.grantState !== "pending"}>
            <div class="board-widget__error-overlay">
              <BoardWidgetError error={state().error} action />
            </div>
          </Show>
        </div>
        <Show when={canMutate() && !props.pageChrome}>
          <span
            class="board-widget__resize-handle"
            aria-hidden="true"
            title={t("board.widget.resizeHandle", { title: label() })}
            onPointerDown={(event) => props.callbacks!.resizePointerDown(props.widget!, event)}
          />
        </Show>
        <Show when={props.widget!.grantState === "granted" && !props.pageChrome}>
          <span class="board-widget__grant-dot" aria-hidden="true" />
        </Show>
      </section>
    </Show>
  );
}

export const BoardWidgetCell = defineSolidBridge<BoardWidgetCellProps, BoardWidgetCellMethods>(
  "openclaw-board-widget-cell",
  BoardWidgetCellContent,
  {
    properties: {
      widget: { default: undefined, attribute: false },
      boardRevision: { default: 0, type: Number },
      rect: { default: undefined, attribute: false },
      contentHeightPx: { default: undefined, attribute: false },
      fitAutoContent: { default: false, type: Boolean },
      pageChrome: { default: false, type: Boolean },
      tabs: { default: [], attribute: false },
      session: { default: { sessionKey: "" }, attribute: false },
      sessionKey: { default: "", attribute: false },
      widgetFrameUrl: { default: undefined, attribute: false },
      callbacks: { default: undefined, attribute: false },
      active: { default: true, type: Boolean },
      bridgeEnabled: { default: true, type: Boolean },
      dragging: { default: false, type: Boolean },
      focusTabIndex: { default: -1, type: Number },
      positionInSet: { default: 1, type: Number },
      setSize: { default: 1, type: Number },
      busy: { default: false, type: Boolean },
      canMutate: { default: true, type: Boolean },
      canGrant: { default: true, type: Boolean },
      loadingCovered: { default: false, type: Boolean },
    },
    methods: {
      selectMenuItem: (host, value) => cells.get(host)?.selectMenuItem(value),
      teardown: async (host) => {
        await cells.get(host)?.teardown();
      },
      restartAfterTeardown: (host) => cells.get(host)?.restartAfterTeardown(),
    },
  },
);
