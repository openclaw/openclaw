import { createIdleImport } from "../../../lib/idle-import.ts";

const environment = createIdleImport(() => import("./chat-details-environment-body.tsx"));
const composition = createIdleImport(() => import("./chat-details-session.tsx"));
const observers = createIdleImport(() => import("./chat-details-observers.tsx"));

export const loadChatDetailsObservers = observers.load;
export const loadChatDetailsEnvironmentBody = environment.load;
export async function loadChatDetailsDesktopComposition() {
  // Cached Details paints its data owners and sections together in the first frame.
  const [module] = await Promise.all([composition.load(), environment.load(), observers.load()]);
  return module;
}
