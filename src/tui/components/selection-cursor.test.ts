import { CURSOR_MARKER, type Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { filterableSelectListTheme } from "../theme/theme.js";
import { buildSessionChoices } from "../tui-session-picker.js";
import { FilterableSelectList } from "./filterable-select-list.js";
import { SelectionCursor } from "./selection-cursor.js";

const list = (lines: string[]) => {
  const inner: Component & { focused: boolean; lines: string[] } = {
    focused: false,
    lines,
    render() {
      return this.lines;
    },
    invalidate: () => undefined,
  };
  return { inner, wrapper: new SelectionCursor(inner) };
};

const strip = (lines: string[]) => lines.map((line) => line.split(CURSOR_MARKER).join(""));

describe("SelectionCursor", () => {
  it("parks the cursor on the selected row only and blanks the arrow cue", () => {
    const { wrapper } = list([`search: ${CURSOR_MARKER}`, "  one", "→ two", "  three"]);
    wrapper.focused = true;
    expect(wrapper.render(40)).toEqual(["search: ", "  one", `  ${CURSOR_MARKER}two`, "  three"]);
  });

  it("changes only the cursor, not the row text, when the selection moves", () => {
    const { inner, wrapper } = list(["→ one", "  two"]);
    wrapper.focused = true;
    const first = wrapper.render(40);
    inner.lines = ["  one", "→ two"];
    const second = wrapper.render(40);
    expect(strip(second)).toEqual(strip(first));
    expect(first[0]).toContain(CURSOR_MARKER);
    expect(second[1]).toContain(CURSOR_MARKER);
  });

  it("keeps label text that looks like an arrow, a counter or a divider", () => {
    const { wrapper } = list(["→ step one", "  indented  detail", "───", "", "→ 1/2", "  3/4"]);
    wrapper.focused = true;
    expect(strip(wrapper.render(40))).toEqual([
      "→ step one",
      "  indented  detail",
      "───",
      "",
      "  1/2",
      "  3/4",
    ]);
  });

  it("splits aligned rows at their shared column, not at a double space in a label", () => {
    const { wrapper } = list(["→ hi  there   now", "  other       2d"]);
    wrapper.focused = true;
    expect(strip(wrapper.render(40))).toEqual(["  hi  there, now", "  other, 2d"]);
  });

  it("shows the session picker without its divider or position counter", () => {
    const sessions = Array.from({ length: 12 }, (_, index) => ({ key: `agent:main:s${index}` }));
    const picker = new FilterableSelectList(
      buildSessionChoices(sessions),
      9,
      filterableSelectListTheme,
    );
    picker.stableWindow = true;
    const wrapper = new SelectionCursor(picker);
    wrapper.focused = true;
    const rows = strip(wrapper.render(80)).map((row) => row.trimEnd());
    expect(rows.slice(1)).toEqual(Array.from({ length: 9 }, (_, index) => `  s${index}`));
  });

  it("turns column padding into a comma so a row reads as one phrase", () => {
    const { wrapper } = list([
      "→ main                        just now · hi, this is a test",
      "  other   2d",
    ]);
    wrapper.focused = true;
    expect(strip(wrapper.render(80))).toEqual([
      "  main, just now · hi, this is a test",
      "  other, 2d",
    ]);
  });

  it("keeps a description whose text ends the label", () => {
    const { wrapper } = list(["→ my-default          default", "  other"]);
    wrapper.focused = true;
    expect(strip(wrapper.render(80))).toEqual(["  my-default, default", "  other"]);
  });

  it("leaves prompt text with double spaces and a bare 3/4 line alone", () => {
    const { wrapper } = list(["Pick one:  fast  or  slow", "3/4", "→ yes", "  no"]);
    wrapper.focused = true;
    expect(strip(wrapper.render(80))).toEqual([
      "Pick one:  fast  or  slow",
      "3/4",
      "  yes",
      "  no",
    ]);
  });

  it("keeps a description that is not a restatement of the label", () => {
    const { wrapper } = list(["→ opencode-go/glm-5.3-air          GLM 5.3"]);
    wrapper.focused = true;
    expect(strip(wrapper.render(80))).toEqual(["  opencode-go/glm-5.3-air, GLM 5.3"]);
  });

  it("keeps a session title arrow and parks the cursor on the selected session", () => {
    const picker = new FilterableSelectList(
      buildSessionChoices([
        { key: "agent:main:main" },
        { key: "agent:main:deploy", derivedTitle: "→ Deploy" },
      ]),
      9,
      filterableSelectListTheme,
    );
    const wrapper = new SelectionCursor(picker);
    wrapper.focused = true;
    const rows = wrapper.render(80);
    const selected = rows.findIndex((row) => row.includes(CURSOR_MARKER));
    expect(strip(rows).map((row) => row.trimEnd())).toContain("  → Deploy (deploy)");
    expect(strip([rows[selected] ?? ""])[0]?.trimEnd()).toBe("  main");
  });

  it("forwards focus to the wrapped component", () => {
    const { inner, wrapper } = list(["→ a"]);
    wrapper.focused = true;
    expect(inner.focused).toBe(true);
  });

  it("tracks focus itself when the wrapped list has no focused field", () => {
    const inner: Component = { render: () => ["  one", "→ two"], invalidate: () => undefined };
    const wrapper = new SelectionCursor(inner);
    wrapper.focused = true;
    expect(wrapper.render(40)).toEqual(["  one", `  ${CURSOR_MARKER}two`]);
  });

  it("leaves output alone when unfocused or nothing is selected", () => {
    const unfocused = list(["→ a"]).wrapper;
    expect(unfocused.render(40)).toEqual(["→ a"]);
    const none = list([`Question? ${CURSOR_MARKER}`]).wrapper;
    none.focused = true;
    expect(none.render(40)).toEqual([`Question? ${CURSOR_MARKER}`]);
  });
});
