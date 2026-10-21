import { createMemo, createProjection, createUniqueId, For, onSettled, Show } from "solid-js";
import type { SessionBranch } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "./chat-session-versions-mobile.css";

export type ChatSessionVersionsMobileProps = {
  /** Connection/agent/session identity. Change it when the authoritative branch scope changes. */
  scopeKey: string;
  /** Current owner facts, including retained data during refresh or a failed refresh. */
  branches: readonly SessionBranch[];
  query: { status: "loading" | "ready" } | { status: "error"; message: string };
  branchSwitchDisabledReason: string | null;
  onBranchSelect: (leafEntryId: string) => void;
  onRetry?: () => void;
};

/** Interior only: the mobile host owns its header, navigation, retention and scrolling. */
export function ChatSessionVersionsMobile(props: ChatSessionVersionsMobileProps) {
  const id = createUniqueId();
  const buttons = new Map<string, HTMLButtonElement>();
  // Retain presentation order across active-first server responses, never branch facts.
  const order = createProjection<{ scopeKey: string; ids: string[] }>(
    (draft) => {
      const ids = props.branches.map((branch) => branch.leafEntryId);
      const available = new Set(ids);
      const previous = draft.scopeKey === props.scopeKey ? draft.ids : [];
      const retained = previous.filter((key) => available.has(key));
      const known = new Set(retained);
      draft.scopeKey = props.scopeKey;
      draft.ids = [...retained, ...ids.filter((key) => !known.has(key))];
    },
    { scopeKey: "", ids: [] },
  );
  const branchesById = createMemo(
    () => new Map(props.branches.map((branch) => [branch.leafEntryId, branch])),
  );
  const error = () => (props.query.status === "error" ? props.query.message : null);
  const empty = () => props.query.status === "ready" && props.branches.length === 0;
  const select = (branch: SessionBranch) => {
    if (!branch.active && !props.branchSwitchDisabledReason) {
      props.onBranchSelect(branch.leafEntryId);
    }
  };

  return (
    <section
      class={["chat-session-versions-mobile", { "chat-session-versions-mobile--empty": empty() }]}
      aria-label={t("chat.sessionHeader.branches")}
    >
      <Show when={!empty()}>
        <p class="chat-session-versions-mobile__help">{t("chat.sessionHeader.versionsHelp")}</p>
      </Show>
      <Show when={props.branchSwitchDisabledReason}>
        <p id={`${id}-disabled`} class="chat-session-versions-mobile__note" role="status">
          {props.branchSwitchDisabledReason}
        </p>
      </Show>
      <Show when={props.query.status === "loading" && props.branches.length === 0}>
        <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />
      </Show>
      <Show when={error()}>
        <div class="chat-session-versions-mobile__note" role="alert">
          <p>{error()}</p>
          <Show when={props.onRetry}>
            <button type="button" class="btn btn--sm" onClick={() => props.onRetry?.()}>
              {t("common.retry")}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={empty()}>
        <div class="chat-session-versions-mobile__empty" role="status">
          <Icon name="history" />
          <strong>{t("chat.sessionHeader.versionsEmptyTitle")}</strong>
          <p>{t("chat.sessionHeader.versionsEmptyDescription")}</p>
        </div>
      </Show>
      <Show when={props.branches.length > 0}>
        <ol
          class="chat-session-versions-mobile__list"
          role="radiogroup"
          aria-label={t("chat.sessionHeader.branches")}
          aria-describedby={props.branchSwitchDisabledReason ? `${id}-disabled` : undefined}
          aria-busy={props.query.status === "loading" ? "true" : "false"}
          onKeyDown={(event) => {
            const backward = event.key === "ArrowUp" || event.key === "ArrowLeft";
            if (!backward && event.key !== "ArrowDown" && event.key !== "ArrowRight") {
              return;
            }
            event.stopPropagation();
            event.preventDefault();
            const radios = order.ids.flatMap((key) => {
              const button = buttons.get(key);
              return button?.isConnected ? [button] : [];
            });
            const index = radios.findIndex((radio) => radio === event.target);
            if (index < 0 || props.branchSwitchDisabledReason) {
              return;
            }
            const next = radios[(index + (backward ? -1 : 1) + radios.length) % radios.length];
            next?.focus();
            next?.click();
          }}
        >
          <For each={order.ids}>
            {(leafEntryId) => {
              let button: HTMLButtonElement | undefined;
              onSettled(() => () => {
                if (buttons.get(leafEntryId) === button) {
                  buttons.delete(leafEntryId);
                }
              });
              const branch = () => branchesById().get(leafEntryId);
              const relativeTime = () =>
                formatRelativeTimestamp(Date.parse(branch()?.updatedAt ?? ""), { fallback: "" });
              return (
                <Show when={branch()}>
                  {(version) => (
                    <li class="chat-session-versions-mobile__row" role="none">
                      <button
                        ref={(element) => {
                          button = element;
                          buttons.set(leafEntryId, element);
                        }}
                        type="button"
                        role="radio"
                        class="chat-session-versions-mobile__select"
                        aria-checked={version().active ? "true" : "false"}
                        aria-disabled={props.branchSwitchDisabledReason ? "true" : "false"}
                        tabindex={
                          version().active ||
                          (!props.branches.some((item) => item.active) &&
                            leafEntryId === order.ids[0])
                            ? 0
                            : -1
                        }
                        onClick={() => select(version())}
                      >
                        <span class="chat-session-versions-mobile__radio" aria-hidden="true" />
                        <span class="chat-session-versions-mobile__copy">
                          <span class="chat-session-versions-mobile__title">
                            {version().headline || t("chat.sessionHeader.untitledBranch")}
                          </span>
                          <span class="chat-session-versions-mobile__meta">
                            {version().active ? `${t("chat.sessionHeader.activeBranch")} · ` : ""}
                            {t(
                              version().messageCount === 1
                                ? "chat.sessionHeader.oneMessage"
                                : "chat.sessionHeader.messages",
                              { count: String(version().messageCount) },
                            )}
                            {!version().active && relativeTime() ? ` · ${relativeTime()}` : ""}
                          </span>
                        </span>
                      </button>
                      <Show when={!version().active}>
                        <span class="chat-session-versions-mobile__more" aria-hidden="true">
                          <Icon name="moreHorizontal" />
                        </span>
                      </Show>
                    </li>
                  )}
                </Show>
              );
            }}
          </For>
        </ol>
      </Show>
    </section>
  );
}
