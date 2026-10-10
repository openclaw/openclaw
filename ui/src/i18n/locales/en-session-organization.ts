import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enSessionOrganization = {
  sessionsView: {
    archiveSessionTree: "Archive session and children…",
    moveToTopLevel: "Move to top level",
    archiveTreeRootRequired:
      "Archive a persistent conversation and its children, not a hidden worker run.",
    archiveSessionTreeConfirm:
      "Archive {count} sessions, including {session}? Sessions moved to the top level or a group are not included.",
    archiveRunningSessions:
      "This selection contains active work. Archiving stops work in the selected sessions.",
    archiveRunningSessionConfirm:
      "Archive {session}? Active work in this session will be stopped. Other conversations are not archived.",
    archiveTreeChanged:
      "The session tree changed. Nothing was archived. Open the menu and try again.",
    sessionMovedToTopLevel: "Session moved to top level",
  },
} satisfies TranslationMap;

export const registerSessionOrganizationEnglish = Object.assign(
  () => {
    Object.assign(en.sessionsView, enSessionOrganization.sessionsView);
  },
  { catalog: enSessionOrganization },
);
