import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    permissionControls: {
      agentDefault: "Agent default",
      agentDefaultWithMode: "Agent default ({mode})",
      defaultDescription: "Uses this agent’s settings.",
      fullRequiresAdmin: "Only admins can turn on Full access.",
      requiresAdmin: "Requires admin access.",
      modes: {
        "read-only": {
          description:
            "Can read files in this session’s workspace. Can’t edit files or run commands.",
        },
        guarded: { description: "Asks you before doing anything outside the workspace." },
        workspace: { description: "An AI reviewer approves actions outside the workspace." },
        full: { description: "Edits files and runs commands anywhere, without review." },
      },
    },
  },
} satisfies TranslationMap;

export const registerPermissionPickerEnglish = Object.assign(() => mergeCatalog(en, catalog), {
  catalog,
});
