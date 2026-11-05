let composition: Promise<typeof import("./chat-details-session.tsx")> | undefined;

export function loadChatDetailsDesktopComposition() {
  return (composition ??= import("./chat-details-session.tsx").then(
    (module) => {
      // Cached sections can render while the independent Environment body warms.
      void module.preloadChatDetailsEnvironment().catch(() => undefined);
      return module;
    },
    (error: unknown) => {
      composition = undefined;
      throw error;
    },
  ));
}
