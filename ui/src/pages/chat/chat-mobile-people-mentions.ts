import { projectChatFields } from "./chat-field-projection.ts";
import type {
  HumanMentionAccess,
  HumanMentionRead,
} from "./components/chat-composer-mention-menu.tsx";

export type ChatMobilePeopleMentions = {
  readonly status: "idle" | "loading" | "ready" | "unavailable" | "error" | "insert-rejected";
  readonly error: string | undefined;
  readonly truncated: boolean;
  read: () => HumanMentionRead | null;
  /** Activate only on entry to People; release on leaving that page. */
  activate: () => () => void;
  /** An explicit search/retry, never a render-time request. */
  request: (query?: string) => Promise<void>;
  /** Caller closes the page only on true. The native composer owns deferred focus. */
  insert: (profileId: string) => boolean;
};

/** Page presentation only. The receipt is the last native interaction result, not
 * a directory cache. Rendering must not read back into the composer computation
 * that consumes this same pane's props. The native composer owns caching and insertion admission. */
export function createChatMobilePeopleMentions(
  access: () => HumanMentionAccess | undefined,
): ChatMobilePeopleMentions {
  type Activation = {
    access: HumanMentionAccess | undefined;
    receipt?: HumanMentionRead | null;
    status: ChatMobilePeopleMentions["status"];
    error?: string;
    request?: object;
  };
  const state = projectChatFields<{ active: Activation | undefined }>({ active: undefined });
  const read = () =>
    state.active && state.active.access === access() ? (state.active.receipt ?? null) : null;
  const request = async (query = "") => {
    const page = state.active;
    if (!page) {
      return;
    }
    page.access = access();
    const pending = {};
    page.request = pending;
    page.receipt = page.access?.read(query);
    page.status = "loading";
    page.error = undefined;

    try {
      const result = await page.access?.request(query);
      if (state.active !== page || page.request !== pending) {
        return;
      }
      page.receipt = result;
      page.status = page.access === access() && result ? "ready" : "unavailable";
    } catch (error) {
      if (state.active !== page || page.request !== pending) {
        return;
      }
      page.receipt = page.access?.read(query);
      page.status = "error";
      page.error = error instanceof Error ? error.message : String(error);
    }
  };
  return {
    get status() {
      if (!state.active) {
        return "idle";
      }
      if (state.active.access !== access() || (state.active.status === "ready" && !read())) {
        return "unavailable";
      }
      return state.active.status;
    },
    get error() {
      return state.active?.access === access() ? state.active?.error : undefined;
    },
    get truncated() {
      return read()?.result.truncated ?? false;
    },
    read,
    activate: () => {
      const page = projectChatFields<Activation>({
        access: access(),
        receipt: undefined,
        status: "idle",
        error: undefined,
        request: undefined,
      });
      state.active = page;
      void request();
      return () => {
        if (state.active !== page) {
          return;
        }
        state.active = undefined;
      };
    },
    request,
    insert: (profileId) => {
      const inserted = read()?.insert(profileId) ?? false;
      if (!inserted && state.active) {
        state.active.status = "insert-rejected";
      }
      return inserted;
    },
  };
}
