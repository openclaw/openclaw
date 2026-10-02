export async function openNativeSessionMenu(params: {
  menu: HTMLElementTagNameMap["openclaw-chat-header-session-menu"];
  signal: AbortSignal;
  isCurrent: () => boolean;
}): Promise<boolean> {
  const { menu, signal, isCurrent } = params;
  await menu.updateComplete;
  const dropdown = menu.querySelector("wa-dropdown");
  await dropdown?.updateComplete;
  if (!dropdown || signal.aborted || !isCurrent() || !menu.isConnected) {
    return false;
  }
  if (dropdown.open) {
    return true;
  }
  // Web Awesome's updateComplete precedes its popup/animation. Acknowledge
  // only wa-after-show, and retire a pending open with its native command.
  return new Promise((resolve) => {
    const finish = (opened: boolean) => {
      dropdown.removeEventListener("wa-after-show", shown);
      dropdown.removeEventListener("wa-select", shown, true);
      dropdown.removeEventListener("wa-hide", cancelled);
      signal.removeEventListener("abort", cancelled);
      if (!opened) {
        dropdown.open = false;
      }
      resolve(opened);
    };
    const shown = () => finish(isCurrent() && menu.isConnected && dropdown.open);
    const cancelled = () => finish(false);
    dropdown.addEventListener("wa-after-show", shown);
    // A fast selection proves the menu opened before its animation finishes.
    // Capture it before the action closes the popup or navigates elsewhere.
    dropdown.addEventListener("wa-select", shown, { capture: true });
    dropdown.addEventListener("wa-hide", cancelled, { once: true });
    signal.addEventListener("abort", cancelled, { once: true });
    dropdown.open = true;
  });
}
