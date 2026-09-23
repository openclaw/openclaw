import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enProfileAccess = {
  profilePage: {
    access: {
      title: "Connection access",
      description:
        "Permissions granted to this connection. A role can limit permissions without granting them; reconnect after an administrator changes your access.",
      scopes: "Granted scopes",
      browserRequirement:
        "The Gateway browser panel requires operator.admin. Sessions, tools, and plugins can have additional restrictions.",
      unknown: "The gateway did not report this connection's permissions.",
      none: "No scopes granted.",
    },
  },
} satisfies TranslationMap;

export const registerProfileAccessEnglish = Object.assign(
  () => {
    // Only the Profile page needs this copy; keep it out of the startup catalog.
    en.profilePage = Object.assign({}, en.profilePage, enProfileAccess.profilePage);
  },
  { catalog: enProfileAccess },
);
