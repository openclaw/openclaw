import { SelectList, Text, type Component, type SelectItem } from "@earendil-works/pi-tui";
import { selectListTheme, tuiTheme as theme } from "../theme/theme.js";

export type TuiChoiceSelector = Component & {
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;
  setSelectedIndex?: (index: number) => void;
};

export function createTuiChoiceSelector(items: SelectItem[]): TuiChoiceSelector {
  return new SelectList(items, items.length, selectListTheme);
}

/** Shared confirmation chrome; long task details retain their own bounded viewport. */
export class TuiChoicePrompt implements Component {
  private readonly title: Text;
  private readonly details: Array<{ component: Text; optional: boolean }>;
  private readonly position = new Text();
  private readonly confirmation = new Text();
  private offset = 0;
  private lineCount = 0;

  constructor(
    title: string,
    details: Array<string | { text: string; optional: true }>,
    private readonly selector: TuiChoiceSelector,
    private readonly viewport?: { lines: number; titleLines: number; requestRender: () => void },
  ) {
    this.title = new Text(title);
    this.details = details.map((detail) => ({
      component: new Text(typeof detail === "string" ? detail : detail.text),
      optional: typeof detail !== "string",
    }));
  }

  setConfirmation(text: string): void {
    this.confirmation.setText(theme.accent(text));
  }

  invalidate(): void {
    for (const component of [
      this.title,
      ...this.details.map((detail) => detail.component),
      this.position,
      this.confirmation,
      this.selector,
    ]) {
      component.invalidate();
    }
  }

  render(width: number): string[] {
    const lines = this.details.flatMap(({ component, optional }) => {
      const rendered = component.render(width);
      return !optional || rendered.some((line) => line.trim()) ? rendered : [];
    });
    this.lineCount = lines.length;
    const viewport = this.viewport;
    const maxLines = viewport?.lines ?? lines.length;
    this.offset = Math.min(this.offset, Math.max(0, lines.length - maxLines));
    const visible = lines.slice(this.offset, this.offset + maxLines);
    this.position.setText(
      viewport && lines.length > maxLines
        ? theme.dim(
            `Details ${this.offset + 1}-${this.offset + visible.length} of ${lines.length} · PgUp/PgDn to inspect`,
          )
        : "",
    );
    const position = this.position.render(width);
    const confirmation = this.confirmation.render(width);
    return [
      ...this.title.render(width).slice(0, viewport?.titleLines ?? Infinity),
      ...visible,
      ...(position.some((line) => line.trim()) ? position : []),
      ...(confirmation.some((line) => line.trim()) ? ["", ...confirmation] : []),
      "",
      ...this.selector.render(width),
    ];
  }

  handleInput(data: string): void {
    if (this.viewport && (data === "\u001b[5~" || data === "\u001b[6~")) {
      const delta = (this.viewport.lines - 1) * (data === "\u001b[5~" ? -1 : 1);
      const next = Math.min(
        Math.max(0, this.lineCount - this.viewport.lines),
        Math.max(0, this.offset + delta),
      );
      if (next !== this.offset) {
        this.offset = next;
        for (const { component } of this.details) {
          component.invalidate();
        }
        this.viewport.requestRender();
      }
      return;
    }
    this.selector.handleInput?.(data);
  }
}
