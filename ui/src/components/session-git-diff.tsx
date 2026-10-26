import { Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";

type GitDiffValuesProps = {
  item: { additions?: number; deletions?: number };
  classPrefix: "session-hovercard" | "chat-pr" | "activity-feed";
  locale?: string;
  spaced?: boolean;
};

/** Absent Git facts are not zero-line changes. Callers retain their layout and locale. */
export function GitDiffValues(props: GitDiffValuesProps) {
  return (
    <>
      <Show when={props.item.additions !== undefined}>
        <span class={props.classPrefix + "__additions"}>
          +{props.item.additions?.toLocaleString(props.locale)}
        </span>
      </Show>
      {props.spaced ? " " : null}
      <Show when={props.item.deletions !== undefined}>
        <span class={props.classPrefix + "__deletions"}>
          −{props.item.deletions?.toLocaleString(props.locale)}
        </span>
      </Show>
    </>
  );
}

/** Shared by branch and PR views, with optional navigation owned by the caller. */
export function SessionGitDiff(props: GitDiffValuesProps & { onOpen?: () => void }) {
  const values = () => <GitDiffValues {...props} />;
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
