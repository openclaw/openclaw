export type TuiConfig = {
  /**
   * Enable vi/vim keybinding mode for the TUI input editor.
   * When true, the editor starts in insert mode. Press Escape to enter normal
   * mode for vi-style cursor movement and editing commands.
   * Can also be enabled via the OPENCLAW_TUI_VI_MODE=1 environment variable.
   */
  viMode?: boolean;
};
