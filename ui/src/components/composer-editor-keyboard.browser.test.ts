import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerEditor, type ComposerChip } from "./composer-editor.ts";
afterEach(() => document.body.replaceChildren());
describe.runIf("__vitest_browser__" in globalThis)("composer textbox keyboard", () => {
  function editor(value: string) {
    const element = new ComposerEditor();
    element.value = value;
    element.resolveChips = (text): ComposerChip[] => {
      const start = text.indexOf("$weather");
      return start < 0 ? [] : [{ kind: "skill", start, end: start + 8, label: "Weather" }];
    };
    document.body.append(element);
    return element;
  }
  it.each(["{Enter}", "{Shift>}{Enter}{/Shift}"])(
    "inserts a plain newline with %s without copying indentation",
    async (key) => {
      const { userEvent } = await import("vitest/browser");
      const element = editor("  Keep indentation");
      element.focus();
      await userEvent.keyboard(key);
      expect(element.value).toBe("  Keep indentation\n");
      expect(element.selectionStart).toBe(element.value.length);
    },
  );

  it.each(["{Enter}", "{Shift>}{Enter}{/Shift}"])(
    "keeps a readonly draft unchanged on %s",
    async (key) => {
      const { userEvent } = await import("vitest/browser");
      const element = editor("Keep $weather here.");
      const input = vi.fn();
      element.addEventListener("input", input);
      element.readOnly = true;
      element.focus();
      await userEvent.keyboard(key);
      expect(element.value).toBe("Keep $weather here.");
      expect(input).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "keeps selection-history shortcuts from editing drafts (readonly: %s)",
    async (readOnly) => {
      const { userEvent } = await import("vitest/browser");
      const element = editor("Keep this draft.");
      element.focus();
      await userEvent.keyboard(" More.");
      element.readOnly = readOnly;
      await userEvent.keyboard("{Control>}u{/Control}");
      expect(element.value).toBe("Keep this draft. More.");
      element.readOnly = false;
      await userEvent.keyboard("{Control>}z{/Control}");
      expect(element.value).toBe("Keep this draft.");
      element.readOnly = readOnly;
      await userEvent.keyboard("{Alt>}u{/Alt}");
      expect(element.value).toBe("Keep this draft.");
      element.readOnly = false;
      await userEvent.keyboard("{Control>}y{/Control}");
      expect(element.value).toBe("Keep this draft. More.");
    },
  );

  it.each(["{Backspace}", "{Shift>}{Backspace}{/Shift}"])(
    "deletes one indentation character with %s while keeping chips atomic",
    async (key) => {
      const { userEvent } = await import("vitest/browser");
      const element = editor("    text");
      element.focus();
      element.setSelectionRange(4, 4);
      await userEvent.keyboard(key);
      expect(element.value).toBe("   text");
      expect(element.selectionStart).toBe(3);
      element.value = "$weather";
      await userEvent.keyboard(key);
      expect(element.value).toBe("");
    },
  );

  it.each(["ltr", "rtl"])(
    "moves Home to the visual line start without skipping indentation in %s",
    async (direction) => {
      const { userEvent } = await import("vitest/browser");
      const value = direction === "rtl" ? "  שלום" : "  text";
      const element = editor(value);
      element.dir = direction;
      element.focus();
      await userEvent.keyboard("{Home}");
      expect(element.selectionStart).toBe(0);
      expect(element.selectionEnd).toBe(0);
      element.setSelectionRange(value.length, value.length);
      await userEvent.keyboard("{Shift>}{Home}{/Shift}");
      expect(element.selectionStart).toBe(0);
      expect(element.selectionEnd).toBe(value.length);
    },
  );

  it("keeps Home on the current wrapped visual line", async () => {
    const { userEvent } = await import("vitest/browser");
    const element = editor("  first line words second line words third line words");
    element.style.cssText = "width: 160px; font: 16px / 24px monospace";
    element.focus();
    const caretTop = element.coordsAtPos(element.selectionEnd)!.top;
    await userEvent.keyboard("{Home}");
    expect(element.selectionStart).toBeGreaterThan(0);
    expect(element.coordsAtPos(element.selectionStart)!.top).toBe(caretTop);
    const visualStart = element.selectionStart;
    await userEvent.keyboard("{Home}");
    expect(element.selectionStart).toBe(visualStart);
    element.setSelectionRange(element.value.length, element.value.length);
    await userEvent.keyboard("{Shift>}{Home}{/Shift}");
    expect(element.selectionStart).toBe(visualStart);
    expect(element.selectionEnd).toBe(element.value.length);
  });

  it.each([
    { shift: false, chip: false },
    { shift: true, chip: false },
    { shift: false, chip: true },
    { shift: true, chip: true },
  ])(
    "preserves the vertical column across a short line (shift=$shift, chip=$chip)",
    async ({ shift, chip }) => {
      const { userEvent } = await import("vitest/browser");
      const element = editor(`abcdefghij\nx\nabcdefghij${chip ? "\n$weather" : ""}`);
      element.style.font = "16px / 24px monospace";
      element.focus();
      element.setSelectionRange(8, 8);
      await userEvent.keyboard(
        shift ? "{Shift>}{ArrowDown}{ArrowDown}{/Shift}" : "{ArrowDown}{ArrowDown}",
      );
      expect(element.selectionEnd).toBe(21);
      expect(element.selectionStart).toBe(shift ? 8 : 21);
      if (chip) {
        expect(element.shadowRoot!.querySelector(".composer-chip")).not.toBeNull();
      }
    },
  );
  it.each([
    { forward: true, shift: false },
    { forward: true, shift: true },
    { forward: false, shift: false },
    { forward: false, shift: true },
  ])(
    "pages by the visible composer height (forward=$forward, shift=$shift)",
    async ({ forward, shift }) => {
      const { userEvent } = await import("vitest/browser");
      const value = Array.from({ length: 30 }, () => "abcdefghij").join("\n");
      const element = editor(value);
      element.style.cssText = "height: 80px; overflow: auto; font: 16px / 20px monospace";
      element.focus();
      const start = forward ? 5 : 115;
      element.setSelectionRange(start, start);
      element.scrollTop = forward ? 0 : 200;
      const key = forward ? "{PageDown}" : "{PageUp}";
      await userEvent.keyboard(shift ? `{Shift>}${key}{/Shift}` : key);
      const head =
        element.selectionDirection === "backward" ? element.selectionStart : element.selectionEnd;
      expect(head).toBe(forward ? 38 : 82);
      expect(
        shift ? (forward ? element.selectionStart : element.selectionEnd) : element.selectionStart,
      ).toBe(shift ? start : head);
      await expect
        .poll(() => element.coordsAtPos(head)!.top)
        .toBeGreaterThanOrEqual(element.getBoundingClientRect().top);
      await expect
        .poll(() => element.coordsAtPos(head)!.bottom)
        .toBeLessThanOrEqual(element.getBoundingClientRect().bottom);
    },
  );

  it("keeps repeated End on the current wrapped visual line", async () => {
    const { userEvent } = await import("vitest/browser");
    const element = editor("first line words second line words third line words");
    element.style.cssText = "width: 160px; font: 16px / 24px monospace";
    element.focus();
    element.setSelectionRange(2, 2);
    await userEvent.keyboard("{End}");
    const firstEnd = element.selectionEnd;
    expect(firstEnd).toBeLessThan(element.value.length);
    await userEvent.keyboard("{End}");
    expect(element.selectionEnd).toBe(firstEnd);
    element.setSelectionRange(2, 2);
    await userEvent.keyboard("{Shift>}{End}{/Shift}");
    expect(element.selectionStart).toBe(2);
    expect(element.selectionEnd).toBe(firstEnd);
  });
  it.each([
    { value: "abc   def", start: 6, key: "Backspace", expected: "def" },
    { value: "abc   def", start: 3, key: "Delete", expected: "abc" },
    { value: "中文文字 后文", start: 4, key: "Backspace", expected: "中文 后文" },
    { value: "can't won’t 3.14", start: 5, key: "Backspace", expected: " won’t 3.14" },
    { value: "can't won’t 3.14", start: 12, key: "Delete", expected: "can't won’t " },
    { value: "a😀😀b", start: 5, key: "Backspace", expected: "ab" },
    { value: "$weather after", start: 8, key: "Backspace", expected: " after" },
  ])(
    "deletes a native word from $value at $start with $key",
    async ({ value, start, key, expected }) => {
      const { userEvent } = await import("vitest/browser");
      const element = editor(value);
      element.focus();
      element.setSelectionRange(start, start);
      let before: { value: string; type: string } | undefined;
      element.addEventListener("beforeinput", (event) => {
        if (event instanceof InputEvent) {
          before = { value: element.value, type: event.inputType };
        }
      });
      await userEvent.keyboard(`{Control>}{${key}}{/Control}`);
      expect(element.value).toBe(expected);
      expect(before).toEqual({
        value,
        type: key === "Backspace" ? "deleteWordBackward" : "deleteWordForward",
      });
      await userEvent.keyboard("{Control>}z{/Control}");
      expect(element.value).toBe(value);
    },
  );

  it.each([
    { value: "中文文字 后文", start: 0, end: 0, backward: false, right: true, expected: 2 },
    { value: "abc.def?!", start: 0, end: 0, backward: false, right: true, expected: 3 },
    { value: "abc.def?!", start: 7, end: 7, backward: false, right: true, expected: 9 },
    { value: "can't won’t 3.14", start: 0, end: 0, backward: false, right: true, expected: 5 },
    { value: "a😀😀b", start: 1, end: 1, backward: false, right: true, expected: 5 },
    { value: "abc def ghi", start: 1, end: 5, backward: false, right: true, expected: 7 },
    { value: "abc def ghi", start: 1, end: 5, backward: false, right: false, expected: 4 },
    { value: "abc def ghi", start: 1, end: 5, backward: true, right: true, expected: 3 },
    { value: "abc def ghi", start: 1, end: 5, backward: true, right: false, expected: 0 },
  ])(
    "moves by browser word boundaries from the active head in $value (backward=$backward, right=$right)",
    async ({ value, start, end, backward, right, expected }) => {
      const { userEvent } = await import("vitest/browser");
      const element = editor(value);
      element.focus();
      element.setSelectionRange(start, end, backward ? "backward" : "forward");
      await userEvent.keyboard(`{Control>}{Arrow${right ? "Right" : "Left"}}{/Control}`);
      expect(element.selectionStart).toBe(expected);
      expect(element.selectionEnd).toBe(expected);
    },
  );

  it.each([
    { backward: false, down: false, expected: 16 },
    { backward: false, down: true, expected: 38 },
    { backward: true, down: false, expected: 1 },
    { backward: true, down: true, expected: 23 },
  ])(
    "moves a vertical selection from its active head (backward=$backward, down=$down)",
    async ({ backward, down, expected }) => {
      const { userEvent } = await import("vitest/browser");
      const element = editor("0123456789\n".repeat(5));
      element.style.font = "16px / 20px monospace";
      element.focus();
      element.setSelectionRange(12, 27, backward ? "backward" : "forward");
      await userEvent.keyboard(down ? "{ArrowDown}" : "{ArrowUp}");
      expect(element.selectionStart).toBe(expected);
      expect(element.selectionEnd).toBe(expected);
    },
  );

  it("respects canceled word deletion and readonly while using the full virtualized document", async () => {
    const { userEvent } = await import("vitest/browser");
    const prefix = "A preserved line\n".repeat(1000);
    const element = editor(`${prefix}中文文字 后文`);
    element.style.cssText = "height: 80px; overflow: auto";
    element.focus();
    element.setSelectionRange(prefix.length + 4, prefix.length + 4);
    element.addEventListener("beforeinput", (event) => event.preventDefault(), { once: true });
    await userEvent.keyboard("{Control>}{Backspace}{/Control}");
    expect(element.value).toBe(`${prefix}中文文字 后文`);
    element.readOnly = true;
    await userEvent.keyboard("{Control>}{Backspace}{/Control}");
    expect(element.value).toBe(`${prefix}中文文字 后文`);
    element.readOnly = false;
    await userEvent.keyboard("{Control>}{Backspace}{/Control}");
    expect(element.value).toBe(`${prefix}中文 后文`);
    expect(element.shadowRoot!.querySelectorAll(".cm-line").length).toBeLessThan(1001);
  });
});
