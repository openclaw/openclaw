import type { PluginInstallActionHandle } from "./install-action.tsx";

export function createPluginPageTargets() {
  const headings = new Set<HTMLHeadingElement>();
  const installActions = new Set<PluginInstallActionHandle>();
  return {
    registerRemovalHeading(this: void, heading: HTMLHeadingElement) {
      headings.add(heading);
      return () => headings.delete(heading);
    },
    registerInstallAction(this: void, action: PluginInstallActionHandle) {
      installActions.add(action);
      return () => installActions.delete(action);
    },
    openInstallAction: () => [...installActions].find((action) => action.open),
    /**
     * Confirmed removal retires the focused Uninstall control. Move focus that fell to the
     * document body onto the remaining view's heading; leave focus the user moved elsewhere.
     */
    focusAfterRemoval: (trigger: Element | null) => {
      const heading = [...headings].findLast((candidate) => candidate.isConnected);
      if (!trigger || trigger.isConnected || document.activeElement !== document.body) {
        return;
      }
      if (!heading) {
        return;
      }
      heading.tabIndex = -1;
      heading.focus();
    },
  };
}
