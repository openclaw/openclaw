import { ConnectErrorDetailCodes } from "@openclaw/gateway-client/browser";
import type { UsersMentionableParams, UsersMentionableResult } from "@openclaw/gateway-protocol";
import { createStore, For, Repeat, Show } from "solid-js";
import {
  GatewayRequestError,
  resolveGatewayErrorDetailCode,
  type GatewayBrowserClient,
} from "../../../api/gateway.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { MAX_HUMAN_MENTIONS, updateHumanMentions } from "../../../lib/chat/human-mentions.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar.ts";
import { paneDomId } from "./chat-composer-dom.ts";
import "../../../styles/chat/mention-menu.css";
import {
  handleComposerMenuKeydown,
  ComposerMenu,
  renderComposerMenuOption as ComposerMenuOption,
} from "./chat-composer-menu.tsx";

export type HumanMentionDirectory = {
  client: GatewayBrowserClient;
  ownerKey: string;
  params: UsersMentionableParams;
};

export type HumanMentionMenuHost = {
  paneId: string;
  getDraft: () => string;
  getMentions: () => readonly HumanMention[];
  getTextarea: () => HTMLTextAreaElement | null;
  commitDraft: (value: string, mentions: readonly HumanMention[]) => void;
};

const MENTION_RESULTS_FRESH_MS = 5 * 60_000;
const MENTION_RESULTS_MAX_AGE_MS = 30 * 60_000;
const MENTION_REFRESH_RETRY_MS = 30_000;
const MENTION_REQUEST_TIMEOUT_MS = 15_000;
const MAX_CACHED_MENTION_QUERIES = 16;

type MentionTarget = { start: number; end: number; query: string; value: string };
type MentionResultSnapshot = {
  result: UsersMentionableResult;
  fetchedAt: number;
  refreshAfter: number;
};
type MentionSearch =
  | { kind: "loading" }
  | { kind: "ready"; result: UsersMentionableResult }
  | {
      kind: "error";
      reason: "unavailable" | "accessDenied" | "profileUnavailable" | "rejected";
    };

function findMentionTarget(value: string, caret: number): MentionTarget | null {
  if (value.trimStart().startsWith("/")) {
    return null;
  }
  const beforeCaret = value.slice(0, caret);
  const line = beforeCaret.slice(beforeCaret.lastIndexOf("\n") + 1);
  // Code and quoted examples are text, never people-picker invocations.
  if (
    /^\s*>/u.test(line) ||
    (beforeCaret.match(/```/gu)?.length ?? 0) % 2 !== 0 ||
    (line.match(/`/gu)?.length ?? 0) % 2 !== 0
  ) {
    return null;
  }
  // Spaces can separate name parts, but a space immediately after @ ends the
  // invocation so literal at-signs cannot turn the rest of a prompt into a query.
  const match = /(?:^|[\s([{])@(?! )([\p{L}\p{N}\p{M}_. -]{0,128})$/u.exec(beforeCaret);
  if (!match) {
    return null;
  }
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  let end = caret;
  // Replace the rest of the current word, not later words that may be ordinary prose.
  while (end < value.length && /[\p{L}\p{N}\p{M}_.-]/u.test(value[end] ?? "")) {
    end += 1;
  }
  return { start, end, query, value };
}

type MentionPerson = UsersMentionableResult["users"][number];
type MentionInput = Pick<HTMLTextAreaElement, "value" | "selectionStart" | "selectionEnd">;
type MentionIntent = "input" | "trigger" | "selection";
type MentionMenuState = {
  target: MentionTarget | null;
  search: MentionSearch | null;
  index: number;
  selectedProfileId: string | undefined;
};

/** One bounded suggestion lifecycle shared by existing- and new-session composers. */
export function createHumanMentionMenu(onOpenChange?: (nextOpen: boolean) => void) {
  let directory: HumanMentionDirectory | undefined;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const [state, setState] = createStore<MentionMenuState>({
    target: null,
    search: null,
    index: 0,
    selectedProfileId: undefined,
  });
  const selectedAvatars = new Map<string, string>();
  const selectedAvatarUrls: ReadonlyMap<string, string> = selectedAvatars;
  const results = new Map<string, MentionResultSnapshot>();
  const requests = new Map<string, Promise<UsersMentionableResult>>();

  function syncDirectory(next: HumanMentionDirectory | undefined) {
    // Results are query snapshots: unrelated session/presence traffic must not cancel typing.
    // Owner changes fence them here; admission rechecks current recipient visibility.
    if (
      directory?.client === next?.client &&
      directory?.ownerKey === next?.ownerKey &&
      JSON.stringify(directory?.params) === JSON.stringify(next?.params)
    ) {
      return;
    }
    setState(close);
    results.clear();
    requests.clear();
    selectedAvatars.clear();
    // Each lifetime owns a fresh descriptor, even if a caller reuses A after A → B → A.
    // Old requests must never become current again or retire a replacement query.
    directory = next ? { ...next } : undefined;
  }

  function cancelSearch() {
    generation += 1;
    clearTimeout(timer);
    timer = undefined;
  }

  function close(draft: MentionMenuState) {
    const wasOpen = draft.target !== null;
    cancelSearch();
    Object.assign(draft, { target: null, search: null, index: 0, selectedProfileId: undefined });
    if (wasOpen) {
      onOpenChange?.(false);
    }
  }

  function dispose() {
    cancelSearch();
    directory = undefined;
    results.clear();
    requests.clear();
    selectedAvatars.clear();
  }

  function update(
    draft: MentionMenuState,
    input: MentionInput,
    intent: MentionIntent = "selection",
  ) {
    const { value, selectionStart: caret, selectionEnd } = input;
    const target = directory ? findMentionTarget(value, caret) : null;
    // Only typing may extend a full-name query. Moving into untouched prose or
    // another @ must retire the current invocation, not start a different search.
    const previous = draft.target;
    const leftTarget =
      intent === "selection" &&
      previous !== null &&
      (value !== previous.value || target?.start !== previous.start || selectionEnd > previous.end);
    if (!target || leftTarget || (!previous && intent !== "trigger")) {
      if (previous) {
        close(draft);
      }
      return;
    }
    if (previous?.start === target.start && intent !== "trigger") {
      // Keep later name parts in the replacement range when navigating or editing
      // an earlier part. Input shifts that range; selection never changes its extent.
      target.end = Math.max(target.end, previous.end + value.length - previous.value.length);
    }
    if (previous?.start !== target.start) {
      draft.selectedProfileId = undefined;
    }
    draft.target = target;
    if (previous?.start !== target.start || previous.query !== target.query) {
      searchPeople(draft);
    }
    if (!previous) {
      onOpenChange?.(true);
    }
  }

  function showResults(draft: MentionMenuState, result: UsersMentionableResult) {
    draft.index = Math.max(
      0,
      result.users.findIndex((user) => user.profileId === draft.selectedProfileId),
    );
    draft.selectedProfileId = result.users[draft.index]?.profileId;
    draft.search = { kind: "ready", result };
  }

  function searchPeople(draft: MentionMenuState) {
    const target = draft.target;
    const source = directory;
    if (!target || !source) {
      return;
    }
    cancelSearch();
    const query = target.query;
    // Only the Gateway knows every searchable identity field and its matching rules.
    // Reuse exact snapshots; display-name filtering would lose verified-login matches.
    let cached = results.get(query);
    if (cached && Date.now() - cached.fetchedAt >= MENTION_RESULTS_MAX_AGE_MS) {
      results.delete(query);
      cached = undefined;
    }
    if (cached) {
      showResults(draft, cached.result);
      if (Date.now() < cached.refreshAfter && !requests.has(query)) {
        return;
      }
    } else {
      draft.search = { kind: "loading" };
    }
    const requestGeneration = generation;
    timer = setTimeout(() => {
      timer = undefined;
      const refreshed = results.get(query);
      if (refreshed && refreshed !== cached && Date.now() < refreshed.refreshAfter) {
        setState((next) => showResults(next, refreshed.result));
        return;
      }
      let request = requests.get(query);
      if (!request) {
        // Failed refreshes do not extend data lifetime or retry on every reopen.
        if (cached) {
          cached.refreshAfter = Date.now() + MENTION_REFRESH_RETRY_MS;
        }
        request = source.client
          .request<UsersMentionableResult>(
            "users.mentionable",
            { ...source.params, query },
            // A hung read must release the shared slot so reopening can retry.
            { timeoutMs: MENTION_REQUEST_TIMEOUT_MS },
          )
          .then((result) => {
            // Closing or typing ahead retires presentation, not useful query snapshots.
            // A replaced directory must never inherit the previous owner's response.
            if (directory === source) {
              results.delete(query);
              if (results.size === MAX_CACHED_MENTION_QUERIES) {
                results.delete(results.keys().next().value!);
              }
              const fetchedAt = Date.now();
              results.set(query, {
                result,
                fetchedAt,
                refreshAfter: fetchedAt + MENTION_RESULTS_FRESH_MS,
              });
            }
            return result;
          })
          .finally(() => {
            if (directory === source) {
              requests.delete(query);
            }
          });
        requests.set(query, request);
      }
      void request.then(
        (result) => {
          if (requestGeneration === generation) {
            setState((next) => showResults(next, result));
          }
        },
        (error: unknown) => {
          // Transient outages keep stale suggestions usable. An authoritative
          // rejection (including lost access) evicts this directory instead.
          const profileUnavailable =
            error instanceof GatewayRequestError &&
            resolveGatewayErrorDetailCode(error) ===
              ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE;
          const rejected =
            error instanceof GatewayRequestError &&
            (error.gatewayCode !== "UNAVAILABLE" || profileUnavailable);
          if (directory === source && rejected) {
            results.clear();
            requests.clear();
            directory = { ...source };
            cancelSearch();
            setState((next) => {
              if (next.target) {
                next.search = {
                  kind: "error",
                  reason: profileUnavailable
                    ? "profileUnavailable"
                    : error.gatewayCode === "FORBIDDEN"
                      ? "accessDenied"
                      : "rejected",
                };
              }
            });
          } else if (requestGeneration === generation && !cached) {
            setState((next) => {
              next.search = { kind: "error", reason: "unavailable" };
            });
          }
        },
      );
    }, 150);
  }

  function handleKeydown(event: KeyboardEvent, host: HumanMentionMenuHost) {
    let handled = false;
    setState((draft) => {
      if (!draft.target || event.defaultPrevented || event.isComposing || event.keyCode === 229) {
        return;
      }
      if (draft.search?.kind === "error" && event.key === "Tab") {
        return;
      }
      const users = draft.search?.kind === "ready" ? draft.search.result.users : [];
      handled = handleComposerMenuKeydown(event, {
        count: users.length,
        index: draft.index,
        consumeEmpty: true,
        close: () => close(draft),
        move: (index) => {
          draft.index = index;
          draft.selectedProfileId = users[index]?.profileId;
          return users[index] ? paneDomId(host.paneId, `mention-option-${index}`) : null;
        },
        select: () => select(draft, users[draft.index]!, host),
      });
    });
    return handled;
  }

  function select(draft: MentionMenuState, person: MentionPerson, host: HumanMentionMenuHost) {
    const textarea = host.getTextarea();
    const current = textarea?.value ?? host.getDraft();
    // Revalidate and consume the target within one draft: Solid publishes writes
    // after the event, but selection must use the current textarea immediately.
    update(
      draft,
      textarea ?? { value: current, selectionStart: current.length, selectionEnd: current.length },
    );
    const target = draft.target;
    if (!target || host.getMentions().length >= MAX_HUMAN_MENTIONS) {
      return;
    }
    const label = `@${person.displayName}`;
    const replacement = `${label} `;
    const next = `${current.slice(0, target.start)}${replacement}${current.slice(target.end)}`;
    const mentions = [
      ...updateHumanMentions(current, next, host.getMentions(), {
        value: current,
        start: target.start,
        end: target.end,
        inputType: "insertReplacementText",
      }),
      { profileId: person.profileId, start: target.start, end: target.start + label.length },
    ].toSorted((a, b) => a.start - b.start);
    // Preserve only selected presentation URLs, so the shared loader reuses the
    // exact image already requested by the picker. Recipient metadata stays unchanged.
    for (const profileId of selectedAvatars.keys()) {
      if (!mentions.some((mention) => mention.profileId === profileId)) {
        selectedAvatars.delete(profileId);
      }
    }
    if (person.avatarUrl) {
      selectedAvatars.set(person.profileId, person.avatarUrl);
    } else {
      selectedAvatars.delete(person.profileId);
    }
    host.commitDraft(next, mentions);
    const caret = target.start + replacement.length;
    close(draft);
    queueMicrotask(() => {
      const currentTextarea = host.getTextarea();
      currentTextarea?.focus({ preventScroll: true });
      currentTextarea?.setSelectionRange(caret, caret);
    });
  }

  return {
    get open() {
      return state.target !== null;
    },
    state,
    selectedAvatarUrls,
    syncDirectory,
    update: (input: MentionInput, intent: MentionIntent = "selection") =>
      setState((draft) => update(draft, input, intent)),
    close: () => setState(close),
    dispose,
    handleKeydown,
    activeId: (paneId: string) =>
      state.search?.kind === "ready" && state.search.result.users[state.index]
        ? paneDomId(paneId, `mention-option-${state.index}`)
        : null,
    activeLabel: () =>
      state.search?.kind === "ready"
        ? (state.search.result.users[state.index]?.displayName ?? "")
        : "",
    select: (person: MentionPerson, host: HumanMentionMenuHost) =>
      setState((draft) => select(draft, person, host)),
    hover: (index: number, profileId: string) =>
      setState((draft) => Object.assign(draft, { index, selectedProfileId: profileId })),
    retry: () => setState(searchPeople),
  };
}

export type HumanMentionMenu = ReturnType<typeof createHumanMentionMenu>;

export function HumanMentionMenuView(props: { args: [HumanMentionMenu, HumanMentionMenuHost] }) {
  const menu = () => props.args[0];
  const host = () => props.args[1];
  const result = () => {
    const search = menu().state.search;
    return search?.kind === "ready" ? search.result : undefined;
  };
  const limited = () => host().getMentions().length >= MAX_HUMAN_MENTIONS;
  const loading = () => menu().state.search?.kind === "loading";
  const error = () => {
    const search = menu().state.search;
    return search?.kind === "error" ? search.reason : null;
  };
  const message = () =>
    limited()
      ? t("chat.mentions.limit")
      : error()
        ? t(`chat.mentions.${error()}`)
        : !loading() && !result()?.users.length
          ? t("chat.mentions.empty")
          : null;
  return (
    <Show when={menu().open}>
      <ComposerMenu
        id={paneDomId(host().paneId, "mention-menu-listbox")}
        class="mention-menu"
        label={t("chat.mentions.menu")}
        trackScroll={false}
        activeId={menu().activeId(host().paneId)}
        revision={menu().state.search}
      >
        <div class="slash-menu-group" aria-busy={loading() ? "true" : "false"}>
          <div class="slash-menu-group__label" role="status">
            {message() ?? t("chat.mentions.menu")}
          </div>
          <Show when={error() === "unavailable" && !limited()}>
            <button
              type="button"
              class="btn btn--sm mention-menu__retry"
              onClick={() => {
                menu().retry();
                host().getTextarea()?.focus({ preventScroll: true });
              }}
            >
              {t("common.retry")}
            </button>
          </Show>
          <Show when={!message() && !loading()}>
            <For each={result()?.users}>
              {(person, index) => (
                <ComposerMenuOption
                  id={paneDomId(host().paneId, `mention-option-${index()}`)}
                  active={index() === menu().state.index}
                  select={() => menu().select(person, host())}
                  hover={() => menu().hover(index(), person.profileId)}
                  icon={
                    <ChatAuthorAvatar
                      sender={{
                        id: person.profileId,
                        name: person.displayName,
                        identity: { type: "profile", id: person.profileId },
                        profileAvatarUrl: person.avatarUrl,
                      }}
                    />
                  }
                  iconHidden={true}
                  name={person.displayName}
                  description={person.online ? t("chat.mentions.online") : null}
                />
              )}
            </For>
          </Show>
          <Show when={!message() && loading()}>
            <Repeat count={3}>
              {() => (
                <div class="slash-menu-item mention-menu__loading" aria-hidden="true">
                  <span class="slash-menu-icon">
                    <span class="skeleton mention-menu__avatar" />
                  </span>
                  <span class="skeleton skeleton-line skeleton-line--medium" />
                </div>
              )}
            </Repeat>
          </Show>
          <Show when={result()?.truncated}>
            <div class="slash-menu-group__label">{t("chat.mentions.truncated")}</div>
          </Show>
        </div>
      </ComposerMenu>
    </Show>
  );
}
