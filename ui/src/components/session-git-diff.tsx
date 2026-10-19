import { Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";

/** Shared by branch and PR views; absent Git facts are not zero-line changes. */
export function SessionGitDiff(props: {
  item: { additions?: number; deletions?: number };
  classPrefix: "session-hovercard" | "chat-pr" | "activity-feed";
  onOpen?: () => void;
}) {
  const values = () => (
    <>
      <Show when={props.item.additions !== undefined}>
        <span class={props.classPrefix + "__additions"}>
          +{props.item.additions?.toLocaleString()}
        </span>
      </Show>
      <Show when={props.item.deletions !== undefined}>
        <span class={props.classPrefix + "__deletions"}>
          −{props.item.deletions?.toLocaleString()}
        </span>
      </Show>
    </>
  );
  return (
    <Show when={props.item.additions !== undefined || props.item.deletions !== undefined}>
      <Show
        when={props.onOpen}
        fallback={<span class={props.classPrefix + "__diff"}>{values()}</span>}
      >
        <button
          class={props.classPrefix + "__diff"}
          type="button"
          aria-label={t("chat.sessionDiff.show")}
          onClick={() => props.onOpen?.()}
        >
          {values()}
        </button>
      </Show>
    </Show>
  );
}
