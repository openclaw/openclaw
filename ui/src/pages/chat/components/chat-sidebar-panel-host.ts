/** Native mount contract shared by pane content and its sidebar region. */
export type SidebarPanelHost = HTMLElement & {
  readonly updateComplete?: Promise<unknown>;
  handleToggleRequest?: (event: Event) => void;
  activateTerminalHost?: () => void;
};
export type SidebarPanelHostRegistration = (element: SidebarPanelHost) => () => void;
