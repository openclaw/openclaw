import { createIdleImport } from "../../../lib/idle-import.ts";

const environment = createIdleImport(() => import("./chat-details-environment-body.tsx"));
const composition = createIdleImport(async () => {
  // Both imports start on cached admission; only the lazy Details boundary waits.
  const [module] = await Promise.all([import("./chat-details-session.tsx"), environment.load()]);
  return module;
});

export const loadChatDetailsEnvironmentBody = environment.load;
export const loadChatDetailsDesktopComposition = composition.load;
