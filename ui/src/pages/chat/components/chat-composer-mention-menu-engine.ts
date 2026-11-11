import { ConnectErrorDetailCodes } from "@openclaw/gateway-client/browser";
import type { UsersMentionableResult } from "@openclaw/gateway-protocol";
import type { StoreSetter } from "solid-js";
import {
  GatewayRequestError,
  resolveGatewayErrorDetailCode,
} from "../../../api/gateway-connect-errors.ts";
import { MAX_HUMAN_MENTIONS, updateHumanMentions } from "../../../lib/chat/human-mentions.ts";
import {
  findMentionTarget,
  type HumanMentionAccess,
  type HumanMentionDirectory,
  type HumanMentionMenuHost,
  type HumanMentionRead,
  type MentionInput,
  type MentionIntent,
  type MentionMenuState,
  type MentionPerson,
  type MentionTarget,
} from "./chat-composer-mention-menu-state.ts";

type MentionEngineOwner = {
  directory: HumanMentionDirectory | undefined;
  readonly generation: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  setState: StoreSetter<MentionMenuState>;
  selectedAvatars: Map<string, string>;
  cancelSearch: () => void;
  update: (draft: MentionMenuState, input: MentionInput, intent?: MentionIntent) => void;
  close: (draft: MentionMenuState) => void;
  syncDirectory: (next: HumanMentionDirectory | undefined) => void;
  matchesDirectory: (next: HumanMentionDirectory | undefined) => boolean;
};

const MENTION_RESULTS_FRESH_MS = 5 * 60_000;
const MENTION_RESULTS_MAX_AGE_MS = 30 * 60_000;
const MENTION_REFRESH_RETRY_MS = 30_000;
const MENTION_REQUEST_TIMEOUT_MS = 15_000;
const MAX_CACHED_MENTION_QUERIES = 16;

type MentionResultSnapshot = {
  result: UsersMentionableResult;
  fetchedAt: number;
  refreshAfter: number;
};

/** Plain query/insertion engine; store and directory lifetime remain with the entry. */
export function createHumanMentionEngine(owner: MentionEngineOwner) {
  const results = new Map<string, MentionResultSnapshot>();
  const requests = new Map<string, Promise<UsersMentionableResult>>();

  function showResults(draft: MentionMenuState, result: UsersMentionableResult) {
    draft.index = Math.max(
      0,
      result.users.findIndex((user) => user.profileId === draft.selectedProfileId),
    );
    draft.selectedProfileId = result.users[draft.index]?.profileId;
    draft.search = { kind: "ready", result };
  }

  function cachedResult(query: string) {
    const cached = results.get(query);
    if (cached && Date.now() - cached.fetchedAt >= MENTION_RESULTS_MAX_AGE_MS) {
      results.delete(query);
      return undefined;
    }
    return cached;
  }

  function requestPeople(query: string, source: HumanMentionDirectory) {
    let request = requests.get(query);
    if (!request) {
      const cached = cachedResult(query);
      // Failed refreshes do not extend data lifetime or retry on every reopen.
      if (cached) {
        cached.refreshAfter = Date.now() + MENTION_REFRESH_RETRY_MS;
      }
      request = source.client
        .request<UsersMentionableResult>(
          "users.mentionable",
          { ...source.params, query },
          { timeoutMs: MENTION_REQUEST_TIMEOUT_MS },
        )
        .then((result) => {
          // Presentation may close; only this directory may inherit the snapshot.
          if (owner.directory === source) {
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
        .catch((error: unknown) => {
          const profileUnavailable =
            error instanceof GatewayRequestError &&
            resolveGatewayErrorDetailCode(error) ===
              ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE;
          const rejected =
            error instanceof GatewayRequestError &&
            (error.gatewayCode !== "UNAVAILABLE" || profileUnavailable);
          if (owner.directory === source && rejected) {
            results.clear();
            requests.clear();
            owner.directory = { ...source };
            owner.cancelSearch();
            owner.setState((next) => {
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
          }
          throw error;
        })
        .finally(() => {
          // A hung read releases this shared slot at the native request deadline.
          if (owner.directory === source) {
            requests.delete(query);
          }
        });
      requests.set(query, request);
    }
    return request;
  }

  function searchPeople(draft: MentionMenuState, delay = 150) {
    const target = draft.target;
    const source = owner.directory;
    if (!target || !source) {
      return;
    }
    owner.cancelSearch();
    const query = target.query;
    // Only the Gateway knows every searchable identity field and its matching rules.
    // Reuse exact snapshots; display-name filtering would lose verified-login matches.
    const cached = cachedResult(query);
    if (cached) {
      showResults(draft, cached.result);
      if (Date.now() < cached.refreshAfter && !requests.has(query)) {
        return;
      }
    } else {
      draft.search = { kind: "loading" };
    }
    const requestGeneration = owner.generation;
    const run = () => {
      owner.timer = undefined;
      const refreshed = results.get(query);
      if (refreshed && refreshed !== cached && Date.now() < refreshed.refreshAfter) {
        owner.setState((next) => showResults(next, refreshed.result));
        return;
      }
      const request = requestPeople(query, source);
      void request.then(
        (result) => {
          if (requestGeneration === owner.generation) {
            owner.setState((next) => showResults(next, result));
          }
        },
        () => {
          // Transient outages keep stale suggestions usable; the query owner evicts rejections.
          if (requestGeneration === owner.generation && !cached) {
            owner.setState((next) => {
              next.search = { kind: "error", reason: "unavailable" };
            });
          }
        },
      );
    };
    if (delay > 0) {
      owner.timer = setTimeout(run, delay);
    } else {
      run();
    }
  }

  function select(draft: MentionMenuState, person: MentionPerson, host: HumanMentionMenuHost) {
    const textarea = host.getTextarea();
    const current = textarea?.value ?? host.getDraft();
    // Revalidate and consume the target within one draft: Solid publishes writes
    // after the event, but selection must use the current textarea immediately.
    owner.update(
      draft,
      textarea ?? { value: current, selectionStart: current.length, selectionEnd: current.length },
    );
    if (draft.target) {
      insert(draft, person, host, draft.target);
    }
  }

  function insert(
    draft: MentionMenuState,
    person: MentionPerson,
    host: HumanMentionMenuHost,
    target: MentionTarget,
    prefix = "",
  ) {
    const textarea = host.getTextarea();
    const current = textarea?.value ?? host.getDraft();
    if (current !== target.value || host.getMentions().length >= MAX_HUMAN_MENTIONS) {
      return false;
    }
    const label = `@${person.displayName}`;
    const replacement = `${prefix}${label} `;
    const next = `${current.slice(0, target.start)}${replacement}${current.slice(target.end)}`;
    const mentions = [
      ...updateHumanMentions(current, next, host.getMentions(), {
        value: current,
        start: target.start,
        end: target.end,
        inputType: "insertReplacementText",
      }),
      {
        profileId: person.profileId,
        start: target.start + prefix.length,
        end: target.start + prefix.length + label.length,
      },
    ].toSorted((a, b) => a.start - b.start);
    // Preserve only selected presentation URLs, so the shared loader reuses the
    // exact image already requested by the picker. Recipient metadata stays unchanged.
    for (const profileId of owner.selectedAvatars.keys()) {
      if (!mentions.some((mention) => mention.profileId === profileId)) {
        owner.selectedAvatars.delete(profileId);
      }
    }
    if (person.avatarUrl) {
      owner.selectedAvatars.set(person.profileId, person.avatarUrl);
    } else {
      owner.selectedAvatars.delete(person.profileId);
    }
    host.commitDraft(next, mentions);
    const caret = target.start + replacement.length;
    owner.close(draft);
    const source = owner.directory;
    queueMicrotask(() => {
      if (owner.directory !== source || host.getTextarea() !== textarea) {
        return;
      }
      const currentTextarea = host.getTextarea();
      currentTextarea?.focus({ preventScroll: true });
      currentTextarea?.setSelectionRange(caret, caret);
    });
    return true;
  }

  function externalAccess(
    getCurrent: () =>
      | { directory: HumanMentionDirectory | undefined; host: HumanMentionMenuHost | undefined }
      | undefined,
  ): HumanMentionAccess {
    const resolveHost = (sync: boolean) => {
      const current = getCurrent();
      if (!current) {
        return undefined;
      }
      if (sync) {
        owner.syncDirectory(current.directory);
      } else if (!owner.matchesDirectory(current.directory)) {
        return undefined;
      }
      return current.host;
    };
    const read = (query = ""): HumanMentionRead | null => {
      // Reading never starts a request or changes the @ menu's presentation.
      if (!resolveHost(false)) {
        return null;
      }
      const source = owner.directory;
      const cached = cachedResult(query);
      if (!source || !cached) {
        return null;
      }
      return {
        result: cached.result,
        insert: (profileId) => {
          const host = resolveHost(true);
          if (!host || owner.directory !== source) {
            return false;
          }
          const person = cachedResult(query)?.result.users.find(
            (user) => user.profileId === profileId,
          );
          const textarea = host.getTextarea();
          if (!person || !textarea || textarea.disabled || textarea.readOnly) {
            return false;
          }
          let inserted = false;
          owner.setState((draft) => {
            owner.update(draft, textarea);
            if (draft.target) {
              inserted = insert(draft, person, host, draft.target);
              return;
            }
            const value = textarea.value;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const prefix = start && !/[\s([{]/u.test(value[start - 1]!) ? " " : "";
            // Apply the native slash/code/quote rules without committing a temporary @.
            const candidate = value.slice(0, start) + prefix + "@" + value.slice(end);
            if (!findMentionTarget(candidate, start + prefix.length + 1)) {
              return;
            }
            inserted = insert(draft, person, host, { start, end, value, query: "" }, prefix);
          });
          return inserted;
        },
      };
    };
    return {
      read,
      request: async (query = "") => {
        if (!resolveHost(true) || !owner.directory) {
          return null;
        }
        const source = owner.directory;
        const cached = cachedResult(query);
        if (!cached || Date.now() >= cached.refreshAfter || requests.has(query)) {
          await requestPeople(query, source);
        }
        if (!resolveHost(false) || owner.directory !== source) {
          return null;
        }
        return read(query);
      },
    };
  }

  return {
    searchPeople,
    select,
    externalAccess,
    clear() {
      results.clear();
      requests.clear();
    },
  };
}
