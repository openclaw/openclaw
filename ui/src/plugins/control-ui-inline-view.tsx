import { createMemo, createSignal, Show, useContext } from "solid-js";
import type { PluginInlineViewBlock } from "../../../src/shared/plugin-inline-view.js";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createIntersectionObserver, createResizeObserver } from "../lib/reactive/observers.ts";
import { sharedPluginsProjection } from "../lib/reactive/shared-application-projections.ts";
import { ContentPresentation } from "../lib/solid/presentation.ts";
import { CustomPluginUiDisabled } from "./control-ui-disabled.solid.tsx";
import { PluginContribution } from "./control-ui-view.solid.tsx";

/** Rows own only a small placeholder offscreen, never a parked plugin/component cache. */
export function PluginInlineView(props: {
  block: PluginInlineViewBlock;
  sessionKey: string;
  agentId?: string;
  presented?: boolean;
}) {
  const app = useOptionalApplication();
  const runtime = app?.plugins ? sharedPluginsProjection(app.plugins) : undefined;
  const [near, setNear] = createSignal(false);
  const [height, setHeight] = createSignal(160);
  const contentPresented = useContext(ContentPresentation);
  // Retained rows can hide and resume without changing their prepared props.
  const active = () => near() && props.presented !== false && contentPresented();
  let root!: HTMLDivElement;
  createIntersectionObserver(
    () => [root],
    ([entry]) => setNear(entry?.isIntersecting === true),
    { rootMargin: "400px 0px" },
  );
  createResizeObserver(
    () => [root],
    ([entry]) => {
      if (active() && entry && entry.contentRect.height > 0) {
        setHeight(entry.contentRect.height);
      }
    },
  );
  const key = () => props.block.pluginId + "/" + props.block.viewId + "@" + props.block.version;
  const status = createMemo(() => {
    const owner = runtime?.read();
    if (owner?.isLoading(props.block.pluginId)) {
      return "loading";
    }
    return owner?.registrations("inlineViews").some((entry) => entry.key === key())
      ? "ok"
      : "unavailable";
  });
  const notice = () => (
    <div class="card" role="status">
      <strong>{runtime?.read().inlineViewLabel(key()) ?? props.block.viewId}</strong>
      <p class="muted">
        {t(status() === "loading" ? "pluginUi.inlineLoading" : "pluginUi.inlineUnavailable")}
      </p>
      <CustomPluginUiDisabled context={app} pluginId={props.block.pluginId} />
    </div>
  );
  return (
    <div
      class="chat-plugin-inline-view"
      data-plugin-inline-view={props.block.toolCallId}
      ref={(element) => {
        root = element;
      }}
      style={{ "min-height": active() ? undefined : height() + "px" }}
    >
      <Show when={active()}>
        <Show when={status() === "ok"} fallback={notice()}>
          <PluginContribution
            kind="inlineViews"
            contributionKey={key()}
            props={{
              payload: props.block.payload,
              toolCallId: props.block.toolCallId,
              toolName: props.block.toolName,
              sessionKey: props.sessionKey,
              agentId: props.agentId,
            }}
            fallback={notice}
          />
        </Show>
      </Show>
    </div>
  );
}
