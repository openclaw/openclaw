import { createIdleImport } from "../../../lib/idle-import.ts";

const environment = createIdleImport(() => import("./chat-details-environment-body.tsx"));
const composition = createIdleImport(() => import("./chat-details-session.tsx"));

export const loadChatDetailsEnvironmentBody = environment.load;
export let cachedSubagentActivity = false;
export async function loadChatDetailsDesktopComposition(withSubagentActivity = false) {
  cachedSubagentActivity ||= withSubagentActivity;
  // Both imports start on cached admission; only the lazy Details boundary waits.
  const [module] = await Promise.all([composition.load(), environment.load()]);
  return module;
}
