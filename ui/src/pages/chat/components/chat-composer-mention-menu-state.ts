import type { UsersMentionableParams, UsersMentionableResult } from "@openclaw/gateway-protocol";
import { createStore } from "solid-js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { handleComposerMenuKeydown } from "../../../components/composer-menu.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { createIdleImport } from "../../../lib/idle-import.ts";
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

export type HumanMentionRead = {
  result: UsersMentionableResult;
  /** False means the scope/entry/editor is no longer eligible; nothing was inserted. */
  insert: (profileId: string) => boolean;
};

export type HumanMentionAccess = {
  read: (query?: string) => HumanMentionRead | null;
  /** Explicit interaction only. Rejects on lookup failure; null for a retired scope. */
  request: (query?: string) => Promise<HumanMentionRead | null>;
};

export type MentionTarget = { start: number; end: number; query: string; value: string };
type MentionSearch =
  | { kind: "loading" }
  | { kind: "ready"; result: UsersMentionableResult }
  | {
      kind: "error";
      reason: "unavailable" | "accessDenied" | "profileUnavailable" | "rejected";
    };

export function findMentionTarget(value: string, caret: number): MentionTarget | null {
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

export type MentionPerson = UsersMentionableResult["users"][number];
export type MentionInput = Pick<HTMLTextAreaElement, "value" | "selectionStart" | "selectionEnd">;
export type MentionIntent = "input" | "trigger" | "selection";
export type MentionMenuState = {
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
  let latestInput: MentionInput | undefined;
  let engine:
    | ReturnType<typeof import("./chat-composer-mention-menu-engine.ts").createHumanMentionEngine>
    | undefined;
  const engineImport = createIdleImport(
    () => import("./chat-composer-mention-menu-engine.ts"),
    (loaded) => {
      engine = loaded.createHumanMentionEngine({
        get directory() {
          return directory;
        },
        set directory(next) {
          directory = next;
        },
        get generation() {
          return generation;
        },
        set timer(next: ReturnType<typeof setTimeout> | undefined) {
          timer = next;
        },
        setState,
        selectedAvatars,
        cancelSearch,
        update,
        close,
        syncDirectory,
        matchesDirectory,
      });
    },
  );

  function matchesDirectory(next: HumanMentionDirectory | undefined) {
    return (
      directory?.client === next?.client &&
      directory?.ownerKey === next?.ownerKey &&
      JSON.stringify(directory?.params) === JSON.stringify(next?.params)
    );
  }

  function syncDirectory(next: HumanMentionDirectory | undefined) {
    // Results are query snapshots: unrelated session/presence traffic must not cancel typing.
    // Owner changes fence them here; admission rechecks current recipient visibility.
    if (matchesDirectory(next)) {
      return;
    }
    setState(close);
    engine?.clear();
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
    latestInput = undefined;
    Object.assign(draft, { target: null, search: null, index: 0, selectedProfileId: undefined });
    if (wasOpen) {
      onOpenChange?.(false);
    }
  }

  function dispose() {
    cancelSearch();
    directory = undefined;
    latestInput = undefined;
    engineImport.dispose();
    engine?.clear();
    selectedAvatars.clear();
  }

  function update(
    draft: MentionMenuState,
    input: MentionInput,
    intent: MentionIntent = "selection",
  ) {
    latestInput = input;
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

  function searchPeople(draft: MentionMenuState) {
    if (engine) {
      engine.searchPeople(draft);
      return;
    }
    const target = draft.target;
    const source = directory;
    if (!target || !source) {
      return;
    }
    cancelSearch();
    draft.search = { kind: "loading" };
    const requestGeneration = generation;
    const deadline = Date.now() + 150;
    void engineImport.load().then(
      () => {
        if (requestGeneration !== generation || directory !== source || !latestInput) {
          return;
        }
        const input = latestInput;
        setState((next) => {
          const current = findMentionTarget(input.value, input.selectionStart);
          if (
            !next.target ||
            !current ||
            current.start !== next.target.start ||
            current.query !== next.target.query ||
            input.value !== next.target.value ||
            input.selectionEnd > next.target.end
          ) {
            close(next);
            return;
          }
          // Import time overlaps the original debounce; never start a second 150 ms wait.
          engine!.searchPeople(next, Math.max(0, deadline - Date.now()));
        });
      },
      () => {
        if (requestGeneration === generation && directory === source) {
          setState((next) => {
            next.search = { kind: "error", reason: "unavailable" };
          });
        }
      },
    );
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
        select: () => engine?.select(draft, users[draft.index]!, host),
      });
    });
    return handled;
  }

  function externalAccess(
    getCurrent: () =>
      | { directory: HumanMentionDirectory | undefined; host: HumanMentionMenuHost | undefined }
      | undefined,
  ): HumanMentionAccess {
    return {
      read: (query) => engine?.externalAccess(getCurrent).read(query) ?? null,
      request: async (query) => {
        if (!engine) {
          const current = getCurrent();
          if (!current?.host) {
            return null;
          }
          syncDirectory(current.directory);
          const source = directory;
          if (!source) {
            return null;
          }
          await engineImport.load();
          if (directory !== source || !matchesDirectory(getCurrent()?.directory)) {
            return null;
          }
        }
        return engine!.externalAccess(getCurrent).request(query);
      },
    };
  }

  return {
    get open() {
      return state.target !== null;
    },
    state,
    selectedAvatarUrls,
    externalAccess,
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
      setState((draft) => engine?.select(draft, person, host)),
    hover: (index: number, profileId: string) =>
      setState((draft) => Object.assign(draft, { index, selectedProfileId: profileId })),
    retry: () => setState(searchPeople),
  };
}

export type HumanMentionMenu = ReturnType<typeof createHumanMentionMenu>;
