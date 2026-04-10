// Octopus Orchestrator — Keyboard input handler for `octo top`
//
// Raw-mode stdin reader with key mapping. Supports arrow keys,
// tab, enter, q to quit, and number keys for tab switching.
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type KeyAction =
  | "up"
  | "down"
  | "left"
  | "right"
  | "tab"
  | "shift-tab"
  | "enter"
  | "quit"
  | "refresh"
  | "help"
  | { tab: number }
  | "unknown";

export type KeyHandler = (action: KeyAction) => void;

// ──────────────────────────────────────────────────────────────────────────
// Input loop
// ──────────────────────────────────────────────────────────────────────────

/**
 * Start listening for keyboard input in raw mode.
 * Returns a cleanup function to restore the terminal.
 */
export function startKeyListener(handler: KeyHandler): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return () => {};
  }

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf-8");

  const onData = (data: string) => {
    // Ctrl-C or q
    if (data === "\x03" || data === "q" || data === "Q") {
      handler("quit");
      return;
    }

    // Arrow keys
    if (data === "\x1b[A") {
      handler("up");
      return;
    }
    if (data === "\x1b[B") {
      handler("down");
      return;
    }
    if (data === "\x1b[C") {
      handler("right");
      return;
    }
    if (data === "\x1b[D") {
      handler("left");
      return;
    }

    // j/k vim navigation
    if (data === "j") {
      handler("down");
      return;
    }
    if (data === "k") {
      handler("up");
      return;
    }

    // Tab / shift-tab
    if (data === "\t") {
      handler("tab");
      return;
    }
    if (data === "\x1b[Z") {
      handler("shift-tab");
      return;
    }

    // Enter
    if (data === "\r" || data === "\n") {
      handler("enter");
      return;
    }

    // r = refresh
    if (data === "r" || data === "R") {
      handler("refresh");
      return;
    }

    // ? or h = help
    if (data === "?" || data === "h" || data === "H") {
      handler("help");
      return;
    }

    // Number keys 1-9 for tab switching
    const num = parseInt(data, 10);
    if (num >= 1 && num <= 9) {
      handler({ tab: num });
      return;
    }

    handler("unknown");
  };

  stdin.on("data", onData);

  return () => {
    stdin.removeListener("data", onData);
    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }
    stdin.pause();
  };
}
