import { createErrorBoundary } from "@solidjs/signals";
import type { JSX as SolidJSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  Errored,
  onCleanup,
  Show,
  Switch,
  Match,
} from "solid-js";
import { registerBoardEnglish } from "../../i18n/locales/en-board.ts";
import {
  BOARD_DOCUMENT_AUTO_MAX_ROWS,
  boardChromeRowPx,
  exactBoardWidgetHeightPx,
} from "../../lib/board/grid.ts";
import {
  getPluginWidgetKindContribution,
  pluginIdForWidgetKind,
} from "../../lib/board/widgets/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectOwner, projectSource } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { showToast } from "../../lib/toast.ts";
import { CustomPluginUiDisabled } from "../../plugins/control-ui-disabled.solid.tsx";
import { PluginContribution } from "../../plugins/control-ui-view.solid.tsx";
import type { MenuHandle } from "../solid/menu.tsx";
import { BoardMcpAppContent } from "./board-mcp-app-content.tsx";
import { createBoardMcpAppLifecycle } from "./board-mcp-app-lifecycle.ts";
import {
  BoardGrantedCapabilities,
  BoardPendingCapabilities,
} from "./board-widget-capabilities.solid.tsx";
import {
  BOARD_SIZE_PRESETS,
  type BoardWidgetCellHandle,
  type BoardWidgetCellMethods,
  type BoardWidgetCellProps,
} from "./board-widget-cell-options.ts";
import { BoardWidgetError } from "./board-widget-error.tsx";
import { createBoardWidgetFrame, BoardWidgetFrame } from "./board-widget-frame.tsx";
import { BoardWidgetMenu } from "./board-widget-menu.tsx";
import { CoreBoardWidget } from "./core-board-widget.tsx";

registerEnglishCatalog(registerBoardEnglish);

const cells = new WeakMap<HTMLElement, BoardWidgetCellHandle>();

export function boardWidgetPresentationReady(host: HTMLElement): boolean {
  return cells.get(host)?.presentationReady ?? false;
}

function BoardWidgetCellContent(
  props: BoardWidgetCellProps,
  host: SolidBridgeElement<BoardWidgetCellProps, BoardWidgetCellMethods>,
) {
  const context = useOptionalApplication();
  Object.defineProperty(host, "presentationReady", {
    configurable: true,
    get: () => boardWidgetPresentationReady(host),
  });
  onCleanup(() => cells.delete(host));
  const actionBinding = createMemo(
    () =>
      [
        props.boardRevision,
        props.widget?.name,
        props.widget?.instanceId,
        props.widget?.revision,
      ] as const,
    { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
  );
  // A pending receipt would hold sibling bridge roots; observe only settled failures here.
  const [actionFailure, setActionFailure] = createSignal<Promise<void> | undefined>(() => {
    actionBinding();
    return undefined;
  });
  const actionFailed = () => actionFailure() !== undefined;
  const actionOutcome = createMemo(() => actionFailure()?.then(() => null), {
    loadingValue: undefined,
  });
  const [actionPending, setActionPending] = createSignal(false);
  const [widgetRoot, setWidgetRoot] = createSignal<HTMLElement>();
  let mcpElement: HTMLElementTagNameMap["mcp-app-view"] | undefined;
  // Signals commit later; admission must reject a second action in the same tick.
  let actionInFlight = false;
  let menu: MenuHandle | undefined;
  let connected = true;
  // Retain the MCP renderer until its teardown acknowledgement releases it.
  const [renderedMcp, setRenderedMcp] = createSignal(
    (previous = false) => props.widget?.contentKind === "mcp-app" || previous,
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
  // Usage and other Gateway publications do not change a frame's connection
  // authority. Sample mutable lifecycle facts before comparing the binding.
  const gatewayBinding = createMemo(
    () => {
      const snapshot = gateway.read();
      return [
        snapshot?.phase,
        snapshot?.client,
        snapshot?.hello,
        snapshot?.restartPending,
        snapshot?.suspensionPhase,
        context?.gateway.connectionRevision,
      ] as const;
    },
    { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
  );
  // A replacement binding retries a failed body; healthy bindings retain their subtree.
  const [bodyError, setBodyError] = createSignal<{ error: unknown } | undefined>(
    () => {
      void props.widget;
      void props.boardRevision;
      void props.widgetFrameUrl;
      plugins.revision();
      gatewayBinding();
      return undefined;
    },
    { ownedWrite: true },
  );
  const bodyErrored = () => bodyError() !== undefined;
  const appView = createBoardMcpAppLifecycle({
    active,
    connected: () => connected,
    sessionKey: () => props.sessionKey ?? "",
    widget: () => props.widget,
  });
  const frame = createBoardWidgetFrame({
    active,
    connected: () => connected,
    loadingCovered: () => props.loadingCovered ?? false,
    bridgeEnabled: () => props.bridgeEnabled !== false,
    context: () => context,
    refreshFrame: () => props.callbacks?.frameLoadFailed,
    reportContentHeight: (name, height) => props.callbacks?.reportContentHeight(name, height),
    scrollBy: (deltaY) =>
      host.closest("openclaw-board-view")?.scrollBy({ top: deltaY, behavior: "auto" }),
    resolveFrameUrl: () => props.widgetFrameUrl,
    widget: () => props.widget,
  });
  const frameState = projectOwner(frame, (owner) => owner);
  const activeKinds = () => gateway.read()?.hello?.controlUiWidgetKinds ?? [];
  const contribution = createMemo(() =>
    props.widget?.contentKind === "plugin" && !props.widget.frameUrl
      ? getPluginWidgetKindContribution(props.widget.pluginKind, activeKinds())
      : null,
  );

  function runAction(run: () => Promise<void>, failureMessage?: string) {
    if (actionInFlight || props.busy) {
      return;
    }
    actionInFlight = true;
    const binding = actionBinding();
    // A cell-local action would hold the shared owner's busy updates across bridge roots.
    setActionPending(true);
    setActionFailure(undefined);
    menu?.close();
    const completion = (async () => {
      try {
        await run();
      } finally {
        actionInFlight = false;
        if (connected) {
          setActionPending(false);
        }
      }
    })();
    void completion.catch(() => {
      if (connected && actionBinding() === binding) {
        void setActionFailure(completion);
      }
      if (failureMessage) {
        showToast({ message: failureMessage });
      }
    });
  }
  function selectMenuItem(value: string | undefined) {
    const widget = props.widget;
    const callbacks = props.callbacks;
    if (!widget || !callbacks || !active() || !canMutate()) {
      return;
    }
    if (value === "remove") {
      runAction(() => callbacks.remove(widget));
    } else if (value?.startsWith("move:")) {
      runAction(() => callbacks.moveToTab(widget, value.slice(5)));
    } else if (value?.startsWith("resize:")) {
      const size = Object.entries(BOARD_SIZE_PRESETS).find(
        ([preset]) => preset === value.slice(7),
      )?.[1];
      if (size) {
        runAction(() => callbacks.resizeTo(widget, size.w, size.h));
      }
    } else if (value === "height:auto") {
      runAction(() =>
        callbacks.setHeightMode(widget, widget.heightMode !== "fixed" ? "fixed" : "auto"),
      );
    }
  }
  const presentationReady = () =>
    !props.widget?.viewTicket ||
    props.widget.grantState === "pending" ||
    props.widget.grantState === "rejected" ||
    bodyErrored() ||
    frame.presentationReady;
  cells.set(host, {
    get presentationReady() {
      return presentationReady();
    },
    focusWidget: () => widgetRoot()?.focus(),
    selectMenuItem,
    async teardown() {
      await mcpElement?.teardown();
    },
    restartAfterTeardown() {
      mcpElement?.restartAfterTeardown();
    },
  });
  createEffect(
    () => [props.widget, props.boardRevision, active(), gatewayBinding()] as const,
    // Owner callbacks intentionally read the current binding captured above.
    ([widget], previous) => {
      const previousWidget = previous?.[0];
      if (previousWidget && previousWidget !== widget) {
        frame.widgetChanged(previousWidget, widget);
      }
      frame.activityChanged();
    },
  );
  createEffect(
    () =>
      [
        widgetRoot(),
        frameState.revision(),
        props.widget,
        props.boardRevision,
        props.callbacks,
        props.sessionKey,
        gatewayBinding(),
        active(),
        props.loadingCovered,
        props.bridgeEnabled,
        props.widgetFrameUrl,
        bodyErrored(),
      ] as const,
    ([root]) => {
      appView.synchronize(props.callbacks, root ?? null);
      frame.update();
      if (props.loadingCovered && presentationReady()) {
        props.callbacks?.presentationReady?.();
      }
    },
  );
  onCleanup(() => {
    connected = false;
    frame.disconnect();
  });
  const unavailable = () => props.busy || actionPending() || !canMutate();
  const AccessNotice = () => (
    <Show
      when={props.widget?.grantState === "pending"}
      fallback={
        <Show when={props.widget?.grantState === "rejected"}>
          <div
            class="board-widget__grant board-widget__grant--rejected"
            data-test-id="board-rejected"
          >
            <strong>{t("board.widget.rejected")}</strong>
            <span>{t("board.widget.rejectedDetail")}</span>
            <button
              class="btn btn--small"
              type="button"
              disabled={unavailable()}
              onClick={() => runAction(() => props.callbacks!.remove(props.widget!))}
            >
              {t("board.widget.remove")}
            </button>
          </div>
        </Show>
      }
    >
      <BoardPendingCapabilities
        widget={props.widget!}
        disabled={props.busy || actionPending() || !canGrant()}
        onGrant={(decision) =>
          runAction(
            () => props.callbacks!.grant(props.widget!.name, decision),
            t(decision === "granted" ? "board.widget.allowFailed" : "board.widget.rejectFailed"),
          )
        }
        error={
          <Show when={actionFailed()}>
            <Errored
              fallback={(error) => (
                <BoardWidgetError error={formatUiError(error())} action inline />
              )}
            >
              {actionOutcome()}
            </Errored>
          </Show>
        }
      />
    </Show>
  );
  const currentFrameWidget = () => {
    // Reused widget objects still change with board and gateway bindings.
    void props.boardRevision;
    gatewayBinding();
    return props.widget!;
  };
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
          <div class="board-widget__disabled-plugin" data-test-id="board-disabled-plugin">
            <Show
              when={disabled()}
              fallback={
                <strong>{t("board.widget.disabledPlugin", { pluginId: pluginId() })}</strong>
              }
            >
              <CustomPluginUiDisabled context={context} pluginId={pluginId()} />
            </Show>
            <button
              class="btn btn--small"
              type="button"
              disabled={unavailable()}
              onClick={() => runAction(() => props.callbacks!.remove(props.widget!))}
            >
              {t("board.widget.remove")}
            </button>
          </div>
        }
      >
        <Match when={contribution()} keyed>
          {(core) => (
            <CoreBoardWidget
              contribution={core}
              widget={props.widget}
              session={props.session}
              active={active()}
            />
          )}
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
    <Switch fallback={<BoardWidgetFrame state={frameState.read} current={currentFrameWidget} />}>
      <Match when={frameState.read().error}>
        <BoardWidgetError error={frameState.read().error} />
      </Match>
      <Match when={renderedMcp()}>
        <BoardMcpAppContent
          accessNotice={<AccessNotice />}
          active={appView.snapshot().active}
          appView={appView.snapshot().state}
          busy={unavailable()}
          loading={appView.snapshot().loading}
          nearVisible={appView.snapshot().nearVisible}
          sessionKey={props.sessionKey ?? ""}
          widget={props.widget!}
          expired={() => appView.expire()}
          remove={() => runAction(() => props.callbacks!.remove(props.widget!))}
          retry={() => appView.retry()}
          viewRef={(element) => {
            mcpElement = element;
          }}
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

  const BodyBoundary = () => (
    <>
      {createErrorBoundary(
        () => (
          <Body />
        ),
        (error) => {
          const caught = error();
          setBodyError((current) => current ?? { error: caught });
          return null;
        },
      )}
    </>
  );

  const presentation = () =>
    props.widget?.contentKind === "html" || props.widget?.frameUrl
      ? (props.widget.presentation ?? "card")
      : undefined;
  const label = () => props.widget?.title || props.widget?.name || "";
  const scrollable = () =>
    bodyErrored() ||
    actionFailed() ||
    props.widget?.grantState === "pending" ||
    props.widget?.grantState === "rejected" ||
    props.widget?.contentKind === "mcp-app" ||
    (props.widget?.contentKind === "plugin" && !props.widget.frameUrl);
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
      runAction(() => props.callbacks!.nudge(props.widget!, direction));
    } else {
      props.callbacks!.focus(props.widget!, direction);
    }
  }
  return (
    <Show when={props.widget && props.rect && props.callbacks}>
      <section
        ref={setWidgetRoot}
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
                disabled={props.busy || actionPending()}
                onSelect={selectMenuItem}
                ref={(handle) => {
                  menu = handle;
                }}
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
          <Show when={bodyError()} fallback={<BodyBoundary />}>
            {(failure) => <BoardWidgetError error={failure().error} />}
          </Show>
          <Show when={actionFailed() && props.widget!.grantState !== "pending"}>
            <div class="board-widget__error-overlay">
              <Errored
                fallback={(error) => <BoardWidgetError error={formatUiError(error())} action />}
              >
                {actionOutcome()}
              </Errored>
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
      focusWidget: (host) => cells.get(host)?.focusWidget(),
      selectMenuItem: (host, value) => cells.get(host)?.selectMenuItem(value),
      teardown: async (host) => {
        await cells.get(host)?.teardown();
      },
      restartAfterTeardown: (host) => cells.get(host)?.restartAfterTeardown(),
    },
  },
);
