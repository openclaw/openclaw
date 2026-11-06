const loadChatDetailsSession = () => import("./chat-details-session.tsx");
export const loadChatDetailsEnvironmentBody = () => import("./chat-details-environment-body.tsx");
export async function loadChatDetailsDesktopComposition() {
  // Both imports start on cached admission; only the lazy Details boundary waits.
  const [module] = await Promise.all([loadChatDetailsSession(), loadChatDetailsEnvironmentBody()]);
  return module;
}
