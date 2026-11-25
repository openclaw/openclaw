import { Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { PaneSubagentStop } from "../chat-pane-header-view.tsx";
import { renderChatAbortActionSolid } from "./chat-composer-controls.tsx";
import type { createChatComposerContext } from "./chat-composer-frame.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";

export function ChatComposerDisabledBanner(props: {
  banner: NonNullable<ChatComposerProps["disabledBanner"]>;
  showAbortableUi: boolean;
  runControls: ReturnType<typeof createChatComposerContext>["runControlsProps"];
}) {
  const banner = () => props.banner;
  return (
    <div
      class={[
        "agent-chat__disabled-banner",
        {
          "agent-chat__disabled-banner--replacement": banner().kind === "composer-replacement",
          "agent-chat__disabled-banner--compact": banner().presentation === "compact",
        },
        "callout",
        banner().tone === "neutral" ? "agent-chat__disabled-banner--neutral" : "info",
        "callout--action",
      ]}
      role="status"
    >
      {banner().icon ? (
        <span
          class={[
            "agent-chat__disabled-banner-icon",
            `agent-chat__disabled-banner-icon--${banner().icon}`,
          ]}
          aria-hidden="true"
        >
          <Icon
            name={
              ({ archive: "archive", eye: "eye", warning: "alertTriangle" } as const)[
                banner().icon!
              ]
            }
          />
        </span>
      ) : undefined}
      <div class="callout__content">
        {banner().title ? (
          <div class="agent-chat__disabled-banner-title">{banner().title}</div>
        ) : undefined}
        <div class="agent-chat__disabled-banner-detail">{banner().text}</div>
      </div>
      <Show when={banner().onAction}>
        {(onAction) => (
          <button
            type="button"
            class={["btn btn--sm", banner().actionStyle]}
            disabled={
              !banner().actionPending && (Boolean(banner().disabledReason) || banner().busy)
            }
            aria-disabled={banner().actionPending ? "true" : undefined}
            data-authority-pending={banner().actionPending ? "" : undefined}
            aria-busy={banner().busy ? "true" : "false"}
            title={banner().disabledReason ?? undefined}
            onClick={() => {
              if (!banner().actionPending && !banner().disabledReason && !banner().busy) {
                onAction()();
              }
            }}
          >
            {banner().busy ? (
              <>
                <span class="btn__spinner" aria-hidden="true" />
                {banner().busyLabel ?? banner().actionLabel}
              </>
            ) : (
              banner().actionLabel
            )}
          </button>
        )}
      </Show>
      <Show when={banner().stop}>
        {(stop) => <PaneSubagentStop onAbort={stop().onAbort} notice />}
      </Show>
      {banner().kind === "composer-replacement" &&
      banner().presentation !== "compact" &&
      props.showAbortableUi
        ? renderChatAbortActionSolid(props.runControls)
        : undefined}
    </div>
  );
}
