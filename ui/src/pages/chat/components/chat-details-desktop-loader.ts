import { createIdleImport } from "../../../lib/idle-import.ts";

const composition = createIdleImport(
  () => import("./chat-details-session.tsx"),
  (module) => {
    // Cached sections can render while the independent Environment body warms.
    void module.preloadChatDetailsEnvironment().catch(() => undefined);
  },
);

export const loadChatDetailsDesktopComposition = composition.load;
