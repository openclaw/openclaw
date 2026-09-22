// User message component renders user-authored chat entries in the TUI log.
import { tuiTheme as theme } from "../theme/theme.js";
import { MarkdownMessageComponent } from "./markdown-message.js";
import type { TuiImageRenderer } from "./message-images.js";

/** Markdown chat-log row styled as user input. */
export class UserMessageComponent extends MarkdownMessageComponent {
  constructor(text: string, imageRenderer?: TuiImageRenderer) {
    super(
      text,
      1,
      {
        bgColor: (line) => theme.userBg(line),
        color: (line) => theme.userText(line),
      },
      {
        preserveOrderedListMarkers: true,
        preserveBackslashEscapes: true,
      },
      imageRenderer,
    );
  }
}
