import { ConnectErrorDetailCodes } from "@openclaw/gateway-client/browser";
import type { UsersMentionableParams, UsersMentionableResult } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import {
  GatewayRequestError,
  resolveGatewayErrorDetailCode,
  type GatewayBrowserClient,
} from "../../../api/gateway.ts";
import {
  handleComposerMenuKeydown,
  renderComposerMenu,
  renderComposerMenuOption,
} from "../../../components/composer-menu.ts";
import { t } from "../../../i18n/index.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { MAX_HUMAN_MENTIONS, updateHumanMentions } from "../../../lib/chat/human-mentions.ts";
import "../../../styles/chat/mention-menu.css";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import { paneDomId } from "./chat-composer-dom.ts";

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
  | { kind: "error" };

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

/** One bounded suggestion lifecycle shared by existing- and new-session composers. */
export class HumanMentionMenu {
  private directory?: HumanMentionDirectory;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private target: MentionTarget | null = null;
  private search: MentionSearch | null = null;
  private index = 0;
  private selectedProfileId: string | undefined;
  private readonly selectedAvatars = new Map<string, string>();
  private readonly results = new Map<string, MentionResultSnapshot>();
  private readonly requests = new Map<string, Promise<UsersMentionableResult>>();

  get open(): boolean {
    return this.target !== null;
  }

  syncDirectory(directory: HumanMentionDirectory | undefined) {
    // Results are query snapshots: unrelated session/presence traffic must not cancel typing.
    // Owner changes fence them here; admission rechecks current recipient visibility.
    if (
      this.directory?.client === directory?.client &&
      this.directory?.ownerKey === directory?.ownerKey &&
      JSON.stringify(this.directory?.params) === JSON.stringify(directory?.params)
    ) {
      return;
    }
    this.close();
    this.results.clear();
    this.requests.clear();
    this.selectedAvatars.clear();
    // Each lifetime owns a fresh descriptor, even if a caller reuses A after A → B → A.
    // Old requests must never become current again or retire a replacement query.
    this.directory = directory ? { ...directory } : undefined;
  }

  private cancelSearch() {
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  close() {
    this.cancelSearch();
    this.target = null;
    this.search = null;
    this.index = 0;
    this.selectedProfileId = undefined;
  }

  dispose() {
    this.syncDirectory(undefined);
  }

  update(
    input: Pick<HTMLTextAreaElement, "value" | "selectionStart" | "selectionEnd">,
    requestUpdate: () => void,
    intent: "input" | "trigger" | "selection" = "selection",
  ) {
    const { value, selectionStart: caret, selectionEnd } = input;
    const target = this.directory ? findMentionTarget(value, caret) : null;
    // Only typing may extend a full-name query. Moving into untouched prose or
    // another @ must retire the current invocation, not start a different search.
    const leftTarget =
      intent === "selection" &&
      this.target !== null &&
      (value !== this.target.value ||
        target?.start !== this.target.start ||
        selectionEnd > this.target.end);
    if (!target || leftTarget || (!this.open && intent !== "trigger")) {
      if (this.open) {
        this.close();
        requestUpdate();
      }
      return;
    }
    const previous = this.target;
    if (previous?.start === target.start && intent !== "trigger") {
      // Keep later name parts in the replacement range when navigating or editing
      // an earlier part. Input shifts that range; selection never changes its extent.
      target.end = Math.max(target.end, previous.end + value.length - previous.value.length);
    }
    if (previous?.start !== target.start) {
      this.selectedProfileId = undefined;
    }
    this.target = target;
    if (previous?.start === target.start && previous.query === target.query) {
      return;
    }
    this.searchPeople(requestUpdate);
  }

  private showResults(result: UsersMentionableResult) {
    this.index = Math.max(
      0,
      result.users.findIndex((user) => user.profileId === this.selectedProfileId),
    );
    this.selectedProfileId = result.users[this.index]?.profileId;
    this.search = { kind: "ready", result };
  }

  private searchPeople(requestUpdate: () => void) {
    const target = this.target;
    const directory = this.directory;
    if (!target || !directory) {
      return;
    }
    this.cancelSearch();
    const query = target.query;
    // Only the Gateway knows every searchable identity field and its matching rules.
    // Reuse exact snapshots; display-name filtering would lose verified-login matches.
    let cached = this.results.get(query);
    if (cached && Date.now() - cached.fetchedAt >= MENTION_RESULTS_MAX_AGE_MS) {
      this.results.delete(query);
      cached = undefined;
    }
    if (cached) {
      this.showResults(cached.result);
      if (Date.now() < cached.refreshAfter && !this.requests.has(query)) {
        requestUpdate();
        return;
      }
    } else {
      this.search = { kind: "loading" };
    }
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const refreshed = this.results.get(query);
      if (refreshed && refreshed !== cached && Date.now() < refreshed.refreshAfter) {
        this.showResults(refreshed.result);
        requestUpdate();
        return;
      }
      let request = this.requests.get(query);
      if (!request) {
        // Failed refreshes do not extend data lifetime or retry on every reopen.
        if (cached) {
          cached.refreshAfter = Date.now() + MENTION_REFRESH_RETRY_MS;
        }
        request = directory.client
          .request<UsersMentionableResult>(
            "users.mentionable",
            { ...directory.params, query },
            // A hung read must release the shared slot so reopening can retry.
            { timeoutMs: MENTION_REQUEST_TIMEOUT_MS },
          )
          .then((result) => {
            // Closing or typing ahead retires presentation, not useful query snapshots.
            // A replaced directory must never inherit the previous owner's response.
            if (this.directory === directory) {
              this.results.delete(query);
              if (this.results.size === MAX_CACHED_MENTION_QUERIES) {
                this.results.delete(this.results.keys().next().value!);
              }
              const fetchedAt = Date.now();
              this.results.set(query, {
                result,
                fetchedAt,
                refreshAfter: fetchedAt + MENTION_RESULTS_FRESH_MS,
              });
            }
            return result;
          })
          .finally(() => {
            if (this.directory === directory) {
              this.requests.delete(query);
            }
          });
        this.requests.set(query, request);
      }
      void request.then(
        (result) => {
          if (generation === this.generation) {
            this.showResults(result);
            requestUpdate();
          }
        },
        (error: unknown) => {
          // Transient outages keep stale suggestions usable. An authoritative
          // rejection (including lost access) evicts this directory instead.
          const rejected =
            error instanceof GatewayRequestError &&
            (error.gatewayCode !== "UNAVAILABLE" ||
              resolveGatewayErrorDetailCode(error) ===
                ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE);
          if (this.directory === directory && rejected) {
            this.results.clear();
            this.requests.clear();
            this.directory = { ...directory };
            this.cancelSearch();
            if (this.open) {
              this.search = { kind: "error" };
              requestUpdate();
            }
          } else if (generation === this.generation && !cached) {
            this.search = { kind: "error" };
            requestUpdate();
          }
        },
      );
    }, 150);
    requestUpdate();
  }

  activeId(paneId: string): string | null {
    return this.search?.kind === "ready" && this.search.result.users[this.index]
      ? paneDomId(paneId, `mention-option-${this.index}`)
      : null;
  }

  activeLabel(): string {
    return this.search?.kind === "ready"
      ? (this.search.result.users[this.index]?.displayName ?? "")
      : "";
  }

  handleKeydown(event: KeyboardEvent, host: HumanMentionMenuHost, requestUpdate: () => void) {
    if (!this.open || event.defaultPrevented || event.isComposing || event.keyCode === 229) {
      return false;
    }
    if (this.search?.kind === "error" && event.key === "Tab") {
      return false;
    }
    const users = this.search?.kind === "ready" ? this.search.result.users : [];
    return handleComposerMenuKeydown(event, {
      count: users.length,
      index: this.index,
      consumeEmpty: true,
      close: () => {
        this.close();
        requestUpdate();
      },
      move: (index) => {
        this.index = index;
        this.selectedProfileId = users[index]?.profileId;
        requestUpdate();
        return this.activeId(host.paneId);
      },
      select: () => this.select(users[this.index]!, host, requestUpdate),
    });
  }

  private select(
    person: UsersMentionableResult["users"][number],
    host: HumanMentionMenuHost,
    requestUpdate: () => void,
  ) {
    const textarea = host.getTextarea();
    const current = textarea?.value ?? host.getDraft();
    this.update(
      textarea ?? { value: current, selectionStart: current.length, selectionEnd: current.length },
      requestUpdate,
    );
    const target = this.target;
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
    for (const profileId of this.selectedAvatars.keys()) {
      if (!mentions.some((mention) => mention.profileId === profileId)) {
        this.selectedAvatars.delete(profileId);
      }
    }
    if (person.avatarUrl) {
      this.selectedAvatars.set(person.profileId, person.avatarUrl);
    } else {
      this.selectedAvatars.delete(person.profileId);
    }
    host.commitDraft(next, mentions);
    this.close();
    requestUpdate();
    queueMicrotask(() => {
      const currentTextarea = host.getTextarea();
      currentTextarea?.focus({ preventScroll: true });
      currentTextarea?.setSelectionRange(
        target.start + replacement.length,
        target.start + replacement.length,
      );
    });
  }

  get selectedAvatarUrls(): ReadonlyMap<string, string> {
    return this.selectedAvatars;
  }

  render(host: HumanMentionMenuHost, requestUpdate: () => void) {
    if (!this.open) {
      return nothing;
    }
    const result = this.search?.kind === "ready" ? this.search.result : undefined;
    const limited = host.getMentions().length >= MAX_HUMAN_MENTIONS;
    const loading = this.search?.kind === "loading";
    const message = limited
      ? t("chat.mentions.limit")
      : this.search?.kind === "error"
        ? t("chat.mentions.unavailable")
        : !loading && !result?.users.length
          ? t("chat.mentions.empty")
          : null;
    return renderComposerMenu({
      id: paneDomId(host.paneId, "mention-menu-listbox"),
      className: "mention-menu",
      label: t("chat.mentions.menu"),
      trackScroll: false,
      activeId: this.activeId(host.paneId),
      content: html` <div class="slash-menu-group" aria-busy=${loading}>
        <div class="slash-menu-group__label" role="status">
          ${message ?? t("chat.mentions.menu")}
        </div>
        ${
          this.search?.kind === "error" && !limited
            ? html`<button
                type="button"
                class="btn btn--sm mention-menu__retry"
                @click=${() => {
                  this.searchPeople(requestUpdate);
                  host.getTextarea()?.focus({ preventScroll: true });
                }}
              >
                ${t("common.retry")}
              </button>`
            : nothing
        }
        ${
          message
            ? nothing
            : loading
              ? [0, 1, 2].map(
                  () => html`<div class="slash-menu-item mention-menu__loading" aria-hidden="true">
                    <span class="slash-menu-icon"
                      ><span class="skeleton mention-menu__avatar"></span
                    ></span>
                    <span class="skeleton skeleton-line skeleton-line--medium"></span>
                  </div>`,
                )
              : result?.users.map((person, index) =>
                  renderComposerMenuOption({
                    id: paneDomId(host.paneId, `mention-option-${index}`),
                    active: index === this.index,
                    select: () => this.select(person, host, requestUpdate),
                    hover: () => {
                      this.index = index;
                      this.selectedProfileId = person.profileId;
                      requestUpdate();
                    },
                    icon: renderChatAuthorAvatar({
                      id: person.profileId,
                      name: person.displayName,
                      identity: { type: "profile", id: person.profileId },
                      profileAvatarUrl: person.avatarUrl,
                    }),
                    iconHidden: true,
                    name: person.displayName,
                    description: person.online ? t("chat.mentions.online") : nothing,
                  }),
                )
        }
        ${
          result?.truncated
            ? html`<div class="slash-menu-group__label">${t("chat.mentions.truncated")}</div>`
            : nothing
        }
      </div>`,
    });
  }
}
