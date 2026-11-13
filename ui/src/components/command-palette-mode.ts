import type { CommandPaletteMode, CommandPaletteOpenInput } from "./command-palette-contract.ts";

// Text this long, or on more than one line, reads as a prompt rather than a search.
const PROMPT_ENTER_CHARS = 60;

export function paletteDraftShape(message: string, attachments: boolean) {
  const text = message.trim();
  return {
    prompt: attachments || text.includes("\n") || Array.from(text).length >= PROMPT_ENTER_CHARS,
    empty: !text && !attachments,
  };
}

type ModeHooks = {
  draft: () => ReturnType<typeof paletteDraftShape>;
  /** IME composition and a starting session hold the current mode. */
  locked: () => boolean;
  switched: () => void;
};

/** Which mode shows, which one the person chose, and when a draft moves between them. */
export class CommandPaletteModes {
  current: CommandPaletteMode = "search";
  // Reopening returns to the mode the person last chose, never to an automatic switch.
  private chosen: CommandPaletteMode = "search";
  // Compose was entered by a long draft or a file; an emptied draft returns to Search.
  private automatic = false;
  // Search was chosen over a long draft; it stays until the draft reads as a search again.
  private keepSearch = false;

  constructor(private readonly hooks: ModeHooks) {}

  /** An entry point that names a mode is a choice; a retained file or draft may still move it. */
  open(input: Pick<CommandPaletteOpenInput, "mode" | "submitRequested"> = {}) {
    if (input.mode) {
      this.chosen = input.mode;
      this.keepSearch = input.mode === "search" && this.hooks.draft().prompt;
    }
    this.current = input.mode ?? (input.submitRequested ? "compose" : this.chosen);
    this.automatic = false;
    this.follow();
  }

  get handoffMode(): CommandPaletteMode | undefined {
    return this.keepSearch ? "search" : this.chosen === "compose" ? "compose" : undefined;
  }

  readonly choose = (mode: CommandPaletteMode) => this.switch(mode, true);

  /** Moves a long draft to Compose and an emptied automatic one back; a new file shows its draft. */
  follow(attached = false) {
    const draft = this.hooks.draft();
    this.keepSearch &&= draft.prompt && !attached;
    if (this.current === "search" && draft.prompt && !this.keepSearch) {
      this.switch("compose", false);
    } else if (this.current === "compose" && this.automatic && draft.empty) {
      this.switch("search", false);
    }
  }

  private switch(mode: CommandPaletteMode, choice: boolean) {
    if (this.hooks.locked()) {
      return;
    }
    if (choice) {
      this.chosen = mode;
      this.keepSearch = mode === "search" && this.hooks.draft().prompt;
    }
    this.automatic = !choice && mode === "compose";
    if (this.current !== mode) {
      this.current = mode;
      this.hooks.switched();
    }
  }
}
