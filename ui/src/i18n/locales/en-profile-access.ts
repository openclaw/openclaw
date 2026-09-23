import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enProfileAccess = {
  profilePage: {
    access: {
      title: "Your access",
      admin: "You have permission to manage this server.",
      write: "You have permission to send messages and make changes.",
      read: "You have permission to view server information.",
      sessionWrite: "You have permission to work in your own sessions.",
      sessionRead: "You have permission to view your own sessions.",
      limited: "This connection has a limited set of permissions.",
      limits: "Sessions, browsers, and tools may have additional restrictions.",
      help: "Missing something you need?",
      nextStep:
        "Ask your server administrator to review your access. Reconnect after they make changes.",
      reconnect: "Reconnect",
      connecting: "Connecting… Your access will appear when the connection is ready.",
      details: "Technical details",
      description:
        "These permissions were granted when you connected. A role can limit them, but does not grant extra permissions.",
      scopes: "Granted scopes",
      unknown: "Your permissions could not be confirmed.",
      none: "This connection has no permissions.",
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
