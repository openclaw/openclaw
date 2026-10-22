export async function openNativeSessionMenu(params: {
  pane: HTMLElement;
  signal: AbortSignal;
  isCurrent: () => boolean;
  getMenu: () => HTMLElementTagNameMap["openclaw-chat-header-session-menu"] | undefined;
}): Promise<boolean> {
  const { pane, signal, isCurrent, getMenu } = params;
  // The pane can paint before its session metadata makes the header menu available.
  const menu = await new Promise<HTMLElementTagNameMap["openclaw-chat-header-session-menu"] | null>(
    (resolve) => {
      const finish = (
        resolvedMenu: HTMLElementTagNameMap["openclaw-chat-header-session-menu"] | null,
      ) => {
        observer.disconnect();
        signal.removeEventListener("abort", cancelled);
        resolve(resolvedMenu);
      };
      const check = () => {
        if (signal.aborted || !isCurrent() || !pane.isConnected) {
          finish(null);
          return;
        }
        const renderedMenu = getMenu();
        if (renderedMenu) {
          finish(renderedMenu);
        }
      };
      const observer = new MutationObserver(check);
      const cancelled = () => finish(null);
      // Removal is recorded on the pane's former ancestors, not the pane itself.
      // A retained pane loses its selection through its own attributes.
      observer.observe(pane.getRootNode(), { childList: true, subtree: true });
      observer.observe(pane, { attributes: true });
      signal.addEventListener("abort", cancelled, { once: true });
      check();
    },
  );
  if (!menu) {
    return false;
  }
  await menu.updateComplete;
  if (signal.aborted || !isCurrent() || !menu.isConnected) {
    return false;
  }
  return menu.openMenu();
}
