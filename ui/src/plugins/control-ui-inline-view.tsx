import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { PluginInlineViewBlock } from "../../../src/shared/plugin-inline-view.js";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { solidContent } from "../lit/solid-content.tsx";
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
  const runtime = projectSource(app?.plugins, {
    read: (source) => source,
    subscribe: (source, publish) => source?.subscribe(publish) ?? (() => {}),
    equality: "revision",
  });
  const [near, setNear] = createSignal(false);
  const [height, setHeight] = createSignal(160);
  let root!: HTMLDivElement;
  onSettled(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry?.isIntersecting === true),
      { rootMargin: "400px 0px" },
    );
    observer.observe(root);
    const resize = new ResizeObserver(([entry]) => {
      if (root.querySelector("[data-plugin-view-root]") && entry && entry.contentRect.height > 0) {
        setHeight(entry.contentRect.height);
      }
    });
    resize.observe(root);
    return () => {
      observer.disconnect();
      resize.disconnect();
    };
  });
  const key = () => props.block.pluginId + "/" + props.block.viewId;
  const check = createMemo(() => runtime.read()?.inlineViewCheck(key()));
  const valid = createMemo(() => check()?.(props.block.payload));
  const status = createMemo(() => {
    const owner = runtime.read();
    if (props.block.status !== "ok") {
      return props.block.status;
    }
    if (owner?.isLoading(props.block.pluginId)) {
      return "loading";
    }
    if (!check()) {
      return "unavailable";
    }
    if (!valid()) {
      return "invalid-payload";
    }
    return owner?.registrations("inlineViews").some((entry) => entry.key === key())
      ? "ok"
      : "view-missing";
  });
  const notice = () => (
    <div class="card" role="status">
      <strong>{props.block.label ?? props.block.viewId}</strong>
      <p class="muted">
        {t(
          status() === "loading"
            ? "pluginUi.inlineLoading"
            : status() === "invalid-payload"
              ? "pluginUi.inlineInvalidPayload"
              : "pluginUi.inlineUnavailable",
        )}
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
      style={{ "min-height": near() && props.presented !== false ? undefined : height() + "px" }}
    >
      <Show when={near() && props.presented !== false}>
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
            fallback={solidContent(notice, {})}
          />
        </Show>
      </Show>
    </div>
  );
}
