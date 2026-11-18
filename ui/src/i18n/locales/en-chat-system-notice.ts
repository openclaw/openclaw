import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    pendingInputs: {
      endCause: {
        delete: "This message did not run because the session was deleted.",
        reset: "This message did not run because the session was reset. Send it again if needed.",
        revoked: "This message did not run because access was revoked.",
        "restart-unrecoverable": "The Gateway restarted before this message ran. Send it again.",
        overflow: "The queue was full, so this message did not run. Send it again.",
        "policy-refused": "This message was blocked by a policy and did not run.",
        failed: "This message could not be started. Send it again.",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatSystemNoticeEnglish = Object.assign(() => mergeCatalog(en, catalog), {
  catalog,
});
