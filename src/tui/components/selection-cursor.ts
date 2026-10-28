import { CURSOR_MARKER, type Component, type Focusable } from "@earendil-works/pi-tui";

// Pickers mark the selection with "→" in column 0; an arrow further in is label text.
const SELECTED_ROW = /^→ /u;
// Unselected option rows hold the two-column cue slot; prompt text and blank lines do not.
const OPTION_ROW = /^ {2}\S/u;
// A column gap is two or more spaces followed by text; trailing padding is not one.
const COLUMN_GAP = / {2,}(?=\S)/gu;

const gapEnds = (row: string) => [...row.matchAll(COLUMN_GAP)].map((m) => m.index + m[0].length);

// Picker rows pad label and description into columns; a reader hears that padding as dead air.
// Join the two columns with a comma instead. Aligned lists share one description column, so a
// double space inside a label is left alone; unaligned lists split at their first gap.
function tidyColumns(rows: string[]): string[] {
  const ends = rows.map((row) => gapEnds(row.slice(2)));
  const split = ends
    .find((row) => row.length > 0)
    ?.find((end) => ends.every((row) => row.length === 0 || row.includes(end)));
  return rows.map((row, index) => {
    const at = split ?? ends[index]?.[0];
    if (at === undefined || !ends[index]?.includes(at)) {
      return row;
    }
    const body = row.slice(2);
    return `  ${body.slice(0, at).trimEnd()}, ${body.slice(at)}`;
  });
}

/** Screen reader mode: parks the real cursor on the selected row so readers follow selection. */
export class SelectionCursor implements Component, Focusable {
  handleMouse: Component["handleMouse"];

  constructor(private readonly inner: Component) {
    this.handleMouse = inner.handleMouse?.bind(inner);
  }

  // Kept here: pi-tui lists such as SettingsList have no focused field of their own.
  private isFocused = false;

  get focused() {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    if ("focused" in this.inner) {
      this.inner.focused = value;
    }
  }

  get wantsKeyRelease() {
    return this.inner.wantsKeyRelease;
  }

  render(width: number): string[] {
    const lines = this.inner.render(width);
    // Last match: text above the choices may itself start with an arrow.
    const selected = this.focused ? lines.findLastIndex((line) => SELECTED_ROW.test(line)) : -1;
    if (selected < 0) {
      return lines;
    }
    // Rows stay byte-identical while you arrow: only the selected row's "→" cue is blanked and
    // only the zero-width cursor marker moves, so a reader announces the selected row once
    // instead of every repainted row. The inner component's own marker (search box) would
    // compete for it. Only the option rows around the selection are tidied; titles, details and
    // hints keep their text.
    const rows = lines.map((line) => line.split(CURSOR_MARKER).join(""));
    rows[selected] = `  ${rows[selected]?.slice(2)}`;
    let start = selected;
    while (start > 0 && OPTION_ROW.test(rows[start - 1] ?? "")) {
      start -= 1;
    }
    let end = selected + 1;
    while (end < rows.length && OPTION_ROW.test(rows[end] ?? "")) {
      end += 1;
    }
    rows.splice(start, end - start, ...tidyColumns(rows.slice(start, end)));
    rows[selected] = `  ${CURSOR_MARKER}${rows[selected]?.slice(2)}`;
    return rows;
  }

  handleInput(data: string) {
    this.inner.handleInput?.(data);
  }

  invalidate() {
    this.inner.invalidate();
  }
}
