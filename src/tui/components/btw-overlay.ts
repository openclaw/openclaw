import { Container, CURSOR_MARKER, matchesKey, Text, type Focusable } from "@earendil-works/pi-tui";
import { sanitizeRenderableLine, sanitizeRenderableText } from "../tui-formatters.js";

type BtwOverlayParams = { question: string; text: string; isError?: boolean };

const CLOSE_FOOTER = "Esc or Enter: close. c: copy answer.";
const SCROLL_FOOTER = `${CLOSE_FOOTER} Up, Down, Page Up, Page Down: scroll.`;

/** Screen reader mode: a focused, modal BTW answer that closes with Esc/Enter and copies with c. */
export class BtwOverlay extends Container implements Focusable {
  focused = false;
  private readonly notice = new Text("", 0, 0);
  private readonly answer: string;
  private readonly lead: Text;
  private readonly footer = new Text("", 0, 0);
  private noticeText = "";
  private scroll = 0;
  private pageSize = 1;
  private maxScroll = 0;

  constructor(
    params: BtwOverlayParams,
    private readonly actions: {
      close: () => void;
      copy: (text: string) => Promise<boolean>;
      requestRender: () => void;
      rows?: () => number;
    },
  ) {
    super();
    this.answer = sanitizeRenderableText(params.text).trim() || "(no output)";
    this.lead = new Text(
      `${params.isError ? "btw error" : "Your btw answer"}: ${this.answer}`,
      0,
      0,
    );
    this.addChild(new Text(`Question: ${sanitizeRenderableLine(params.question)}`, 0, 0));
    this.addChild(this.footer);
    this.addChild(this.notice);
  }

  override render(width: number): string[] {
    // The overlay compositor does not scroll, so an answer taller than the terminal is windowed
    // here; the question and controls stay visible below it.
    // Measure with the longer scroll footer so wrapping it cannot push the overlay past the
    // terminal.
    this.footer.setText(SCROLL_FOOTER);
    const rest = super.render(width);
    const answerLines = this.lead.render(width);
    const rows = this.actions.rows?.() ?? (process.stdout.rows || 24);
    const room = Math.max(1, rows - rest.length - 2);
    const overflow = answerLines.length > room;
    this.pageSize = room;
    this.maxScroll = overflow ? answerLines.length - room : 0;
    this.scroll = Math.min(this.scroll, this.maxScroll);
    if (!overflow) {
      this.footer.setText(CLOSE_FOOTER);
    }
    const shown = overflow ? answerLines.slice(this.scroll, this.scroll + room) : answerLines;
    const status = overflow
      ? [`Lines ${this.scroll + 1}-${this.scroll + room} of ${answerLines.length}.`]
      : [];
    const lines = [...shown, ...status, ...super.render(width)];
    if (!this.focused) {
      return lines;
    }
    // A reader speaks the line under the cursor: the answer when it opens, the copy result
    // once there is one.
    const target = this.noticeText ? lines.length - this.notice.render(width).length : 0;
    return lines.map((line, index) => (index === target ? `${CURSOR_MARKER}${line}` : line));
  }

  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
      this.actions.close();
    } else if (data === "c" || data === "C") {
      void this.actions.copy(this.answer).then((copied) => {
        this.noticeText = copied ? "Copied to clipboard." : "Copy failed.";
        this.notice.setText(this.noticeText);
        this.invalidate();
        this.actions.requestRender();
      });
    } else {
      const step = matchesKey(data, "down")
        ? 1
        : matchesKey(data, "up")
          ? -1
          : matchesKey(data, "pageDown")
            ? this.pageSize
            : matchesKey(data, "pageUp")
              ? -this.pageSize
              : 0;
      const next = Math.max(0, Math.min(this.maxScroll, this.scroll + step));
      if (step && next !== this.scroll) {
        this.scroll = next;
        // Scrolling hands the cursor back to the answer.
        this.noticeText = "";
        this.notice.setText("");
        this.actions.requestRender();
      }
    }
  }
}
