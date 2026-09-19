import { EditorView } from "@codemirror/view";
import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerEditor, type ComposerChip } from "./composer-editor.ts";
import { icons } from "./icons.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe.runIf("__vitest_browser__" in globalThis)("composer inline editor", () => {
  function editor(value = "Use $weather now") {
    const element = new ComposerEditor();
    element.value = value;
    element.setAttribute("aria-label", "Message");
    element.resolveChips = (text): ComposerChip[] => {
      const start = text.indexOf("$weather");
      return start < 0 ? [] : [{ kind: "skill", start, end: start + 8, label: "Weather" }];
    };
    document.body.append(element);
    return element;
  }

  it("keeps original text while editing, deleting and undoing an atomic chip", async () => {
    const { userEvent } = await import("vitest/browser");
    const element = editor();
    expect(element.shadowRoot!.querySelector(".composer-chip")?.textContent).toBe("$Weather");
    expect(element.value).toBe("Use $weather now");
    element.focus();
    element.setSelectionRange(12, 12);
    await userEvent.keyboard("{ArrowLeft}");
    expect(element.selectionStart).toBe(4);
    await userEvent.keyboard("{ArrowRight}");
    expect(element.selectionStart).toBe(12);
    await userEvent.keyboard("{Backspace}");
    expect(element.value).toBe("Use  now");
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(element.value).toBe("Use $weather now");
    expect(element.shadowRoot!.querySelector(".composer-chip")).not.toBeNull();
  });

  it("forwards submit prevention and emits one input after the raw document changes", async () => {
    const { userEvent } = await import("vitest/browser");
    const element = editor("");
    const values: string[] = [];
    element.addEventListener("input", () => {
      values.push(element.value);
      element.setAttribute("dir", "ltr");
    });
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
      }
    });
    element.focus();
    await userEvent.keyboard("hi{Enter}");
    expect(element.value).toBe("hi");
    expect(values).toEqual(["h", "hi"]);
    element.value = "$weather";
    expect(values).toEqual(["h", "hi"]);
    element.setSelectionRange(8, 8);
    expect(element.insertText("!")).toBe(true);
    expect(values.at(-1)).toBe("$weather!");
    expect(document.activeElement).toBe(element);
  });

  it("preserves native input intent and lets consumers cancel beforeinput and paste", async () => {
    const { userEvent } = await import("vitest/browser");
    const element = editor("");
    const inputs: { data: string | null; inputType: string }[] = [];
    element.addEventListener("input", (event) => {
      if (event instanceof InputEvent) {
        inputs.push({ data: event.data, inputType: event.inputType });
      }
    });
    element.addEventListener("beforeinput", (event) => {
      if (event instanceof InputEvent && event.data === ":") {
        event.preventDefault();
      }
    });
    element.addEventListener("paste", (event) => event.preventDefault());
    element.focus();
    await userEvent.keyboard("@:");
    expect(element.value).toBe("@");
    expect(inputs).toEqual([{ data: "@", inputType: "insertText" }]);
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "blocked paste");
    element.shadowRoot!.querySelector(".cm-content")!.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    expect(element.value).toBe("@");
  });

  it("reprojects a hydrated catalog without replacing text or selection", () => {
    const element = editor("$weather");
    let available = false;
    const provider = (value: string) =>
      available ? [{ kind: "skill" as const, start: 0, end: value.length, label: "Weather" }] : [];
    element.resolveChips = provider;
    element.setSelectionRange(8, 8);
    expect(element.shadowRoot!.querySelector(".composer-chip")).toBeNull();
    available = true;
    element.resolveChips = provider;
    expect(element.shadowRoot!.querySelector(".composer-chip")).not.toBeNull();
    expect(element.value).toBe("$weather");
    expect(element.selectionStart).toBe(8);
  });

  it("records pre-edit selection for keyboard deletion in either direction", async () => {
    const { userEvent } = await import("vitest/browser");
    const element = editor("abc");
    const edits: { type: string; value: string; caret: number }[] = [];
    element.addEventListener("beforeinput", (event) => {
      if (event instanceof InputEvent) {
        edits.push({ type: event.inputType, value: element.value, caret: element.selectionStart });
      }
    });
    element.focus();
    element.setSelectionRange(1, 1);
    await userEvent.keyboard("{Delete}{Backspace}");
    expect(edits).toEqual([
      { type: "deleteContentForward", value: "abc", caret: 1 },
      { type: "deleteContentBackward", value: "ac", caret: 1 },
    ]);
    expect(element.value).toBe("c");
  });

  it("keeps an unfinished token editable until a menu confirms it", async () => {
    const { userEvent } = await import("vitest/browser");
    const element = editor("");
    element.resolveChips = (value, context) =>
      value === "$weather" && !(context.editing && context.caret === value.length)
        ? [{ kind: "skill", start: 0, end: value.length, label: "Weather" }]
        : [];
    element.focus();
    await userEvent.keyboard("$weather");
    expect(element.shadowRoot!.querySelector(".composer-chip")).toBeNull();
    element.refreshChips();
    expect(element.shadowRoot!.querySelector(".composer-chip")).not.toBeNull();
    expect(element.value).toBe("$weather");
    await userEvent.keyboard(" {Backspace}");
    expect(element.shadowRoot!.querySelector(".composer-chip")).not.toBeNull();
    await userEvent.keyboard("{Backspace}");
    expect(element.value).toBe("");
  });

  it("lets beforeinput completion replace a token without inserting its trigger", async () => {
    const { userEvent } = await import("vitest/browser");
    const element = editor(":smile");
    element.addEventListener("beforeinput", (event) => {
      if (event instanceof InputEvent && event.data === ":") {
        element.setSelectionRange(0, element.value.length);
        element.insertText("😀");
        event.preventDefault();
      }
    });
    element.focus();
    element.setSelectionRange(6, 6);
    await userEvent.keyboard(":");
    expect(element.value).toBe("😀");
  });

  it("does not undo into a submitted or previous conversation draft", async () => {
    const { userEvent } = await import("vitest/browser");
    const element = editor("old draft");
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
    await userEvent.keyboard("!");
    element.resetValue("new draft");
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(element.value).toBe("new draft");
    element.value = "";
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(element.value).toBe("");
  });

  it("places the caret after a completed prefix so immediate deletion stays atomic", async () => {
    const { userEvent } = await import("vitest/browser");
    const element = editor("");
    element.focus();
    await userEvent.keyboard("$wea");
    element.value = "$weather ";
    expect(element.selectionStart).toBe(9);
    expect(element.selectionEnd).toBe(9);
    await userEvent.keyboard("{Backspace}{Backspace}");
    expect(element.value).toBe("");
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(element.value).toBe("$weather ");
    expect(element.shadowRoot!.querySelector(".composer-chip")).not.toBeNull();
  });

  it("defers and coalesces selection notifications until the draft owner receives input", async () => {
    const element = editor("");
    let draft = "";
    const selections: number[] = [];
    element.addEventListener("select", () => {
      selections.push(element.selectionStart);
      element.value = draft;
    });
    element.addEventListener("input", () => {
      draft = element.value;
    });
    element.value = "new draft";
    element.setSelectionRange(2, 2);
    element.setSelectionRange(3, 3);
    expect(selections).toEqual([]);
    element.dispatchEvent(new InputEvent("input"));
    await Promise.resolve();
    expect(element.value).toBe("new draft");
    expect(selections).toEqual([3]);
  });

  it("preserves the legacy IME guard before a consumer accepts Enter", () => {
    const element = editor("draft");
    let submitted = false;
    element.addEventListener("keydown", (event) => {
      // oxlint-disable-next-line unicorn/prefer-keyboard-event-key -- Protect the existing IME 229 confirmation contract.
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      if (event.key === "Enter") {
        submitted = true;
        event.preventDefault();
      }
    });
    element.shadowRoot!.querySelector(".cm-content")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    expect(submitted).toBe(false);
  });

  it("connects the focused textbox to popup and label elements outside its shadow root", async () => {
    const element = editor("");
    element.setAttribute("aria-labelledby", "composer-label");
    element.setAttribute("aria-describedby", "composer-help");
    element.setAttribute("aria-controls", "composer-options");
    element.setAttribute("aria-activedescendant", "composer-option");
    const label = document.createElement("span");
    label.id = "composer-label";
    label.textContent = "Draft text";
    const help = document.createElement("span");
    help.id = "composer-help";
    help.textContent = "Choose a skill";
    const list = document.createElement("div");
    list.id = "composer-options";
    list.setAttribute("role", "listbox");
    const option = document.createElement("div");
    option.id = "composer-option";
    option.setAttribute("role", "option");
    option.textContent = "Weather";
    list.append(option);
    document.body.append(label, help, list);
    await Promise.resolve();
    element.focus();
    const content = element.shadowRoot!.querySelector<HTMLElement>(".cm-content")!;
    expect(element.shadowRoot!.activeElement).toBe(content);
    expect(content.ariaLabelledByElements).toEqual([label]);
    expect(content.ariaDescribedByElements).toEqual([help]);
    expect(content.ariaControlsElements).toEqual([list]);
    expect(content.ariaActiveDescendantElement).toBe(option);
    // A keyed popup render may replace its nodes while their IDs stay unchanged.
    const renderProvider = element.resolveChips;
    element.resolveChips = renderProvider;
    const nextList = document.createElement("div");
    nextList.id = list.id;
    nextList.setAttribute("role", "listbox");
    const nextOption = document.createElement("div");
    nextOption.id = option.id;
    nextOption.setAttribute("role", "option");
    nextOption.textContent = "Weather details";
    nextList.append(nextOption);
    list.replaceWith(nextList);
    await Promise.resolve();
    expect(content.ariaControlsElements).toEqual([nextList]);
    expect(content.ariaActiveDescendantElement).toBe(nextOption);
    element.removeAttribute("aria-activedescendant");
    element.removeAttribute("aria-controls");
    await Promise.resolve();
    expect(content.ariaActiveDescendantElement).toBeNull();
    expect(content.ariaControlsElements).toEqual([]);
  });

  it("normalizes Windows line endings before computing draft and replacement offsets", () => {
    const element = new ComposerEditor();
    element.value = "a\r\nb";
    document.body.append(element);
    expect(element.value).toBe("a\nb");
    expect(element.selectionEnd).toBe(3);
    element.value = "first\r\nsecond\rthird";
    expect(element.value).toBe("first\nsecond\nthird");
    expect(element.selectionEnd).toBe(element.value.length);
    element.resetValue("x\r\ny");
    element.setRangeText("1\r\n2", 0, 1, "select");
    expect(element.value).toBe("1\n2\ny");
    expect(element.selectionStart).toBe(0);
    expect(element.selectionEnd).toBe(3);
  });

  it("hands file drops to the attachment owner without starting a prompt text read", () => {
    const element = editor("Keep draft");
    const shell = document.createElement("div");
    document.body.append(shell);
    shell.append(element);
    const attachments: File[] = [];
    shell.addEventListener("drop", (event) => {
      event.preventDefault();
      attachments.push(...event.dataTransfer!.files);
    });
    const file = new File(["Dropped private contents"], "notes.txt", { type: "text/plain" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const reads = vi.spyOn(FileReader.prototype, "readAsText");
    element.shadowRoot!.querySelector(".cm-content")!.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: transfer,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    expect(attachments).toEqual([file]);
    expect(reads).not.toHaveBeenCalled();
    expect(element.value).toBe("Keep draft");
  });

  it("inherits the composer typography and keeps its caret visible on a dark surface", () => {
    const element = editor();
    element.style.cssText =
      "font: 16px / 24px sans-serif; --text: rgb(240, 241, 242); background: rgb(20, 21, 22)";
    const content = element.shadowRoot!.querySelector<HTMLElement>(".cm-content")!;
    const scroller = element.shadowRoot!.querySelector<HTMLElement>(".cm-scroller")!;
    const line = element.shadowRoot!.querySelector<HTMLElement>(".cm-line")!;
    const hostStyle = getComputedStyle(element);
    expect(getComputedStyle(scroller).fontFamily).toBe(hostStyle.fontFamily);
    expect(getComputedStyle(scroller).fontSize).toBe(hostStyle.fontSize);
    expect(getComputedStyle(scroller).lineHeight).toBe(hostStyle.lineHeight);
    expect(getComputedStyle(content).padding).toBe("0px");
    expect(getComputedStyle(line).padding).toBe("0px");
    expect(getComputedStyle(content).caretColor).toBe("rgb(240, 241, 242)");
  });

  it("delegates native host focus to the editable surface", () => {
    const element = editor();
    HTMLElement.prototype.focus.call(element);
    expect(document.activeElement).toBe(element);
    expect(element.shadowRoot!.activeElement).toBe(
      element.shadowRoot!.querySelector(".cm-content"),
    );
    element.readOnly = true;
    element.blur();
    HTMLElement.prototype.focus.call(element);
    expect(element.shadowRoot!.activeElement).toBe(
      element.shadowRoot!.querySelector(".cm-content"),
    );
    element.disabled = true;
    element.blur();
    HTMLElement.prototype.focus.call(element);
    expect(element.shadowRoot!.activeElement).toBeNull();
  });

  it("keeps a confirmed chip atomic when pasting at a formerly interior caret", () => {
    const element = editor("$weather");
    element.resolveChips = () => [];
    element.setSelectionRange(6, 6);
    element.resolveChips = (value) => [
      { kind: "skill", start: 0, end: value.length, label: "Weather" },
    ];
    element.focus();
    expect(element.selectionStart).toBe(8);
    const paste = new DataTransfer();
    paste.setData("text/plain", "X");
    element.shadowRoot!.querySelector(".cm-content")!.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: paste,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    expect(element.value).toBe("$weatherX");
  });

  it("normalizes a newly recognized chip after deleting malformed token text", async () => {
    const { userEvent } = await import("vitest/browser");
    const element = editor("$weathXer");
    element.resolveChips = (value) =>
      value === "$weather" ? [{ kind: "skill", start: 0, end: 8, label: "Weather" }] : [];
    element.focus();
    element.setSelectionRange(6, 6);
    await userEvent.keyboard("{Delete}");
    expect(element.value).toBe("$weather");
    expect(element.selectionStart).toBe(8);
    element.setSelectionRange(2, 5);
    expect(element.selectionStart).toBe(0);
    expect(element.selectionEnd).toBe(8);
    element.insertText("replacement");
    expect(element.value).toBe("replacement");
  });

  it("preserves draft and clipboard on collapsed copy or cut, and copies a selected chip as raw text", () => {
    const element = editor("$weather");
    element.focus();
    element.setSelectionRange(8, 8);
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "original clipboard");
    for (const type of ["copy", "cut"]) {
      element.shadowRoot!.querySelector(".cm-content")!.dispatchEvent(
        new ClipboardEvent(type, {
          clipboardData: clipboard,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
      expect(clipboard.getData("text/plain")).toBe("original clipboard");
      expect(element.value).toBe("$weather");
    }
    element.select();
    element.shadowRoot!.querySelector(".cm-content")!.dispatchEvent(
      new ClipboardEvent("copy", {
        clipboardData: clipboard,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    expect(clipboard.getData("text/plain")).toBe("$weather");
  });

  it("pastes at the composer caret after a different code editor copied a whole line", () => {
    const source = new EditorView({ doc: "copied", parent: document.body });
    try {
      source.focus();
      const clipboard = new DataTransfer();
      source.contentDOM.dispatchEvent(
        new ClipboardEvent("copy", { clipboardData: clipboard, bubbles: true, cancelable: true }),
      );
      expect(clipboard.getData("text/plain")).toBe("copied");
      const element = editor("left right");
      element.focus();
      element.setSelectionRange(5, 5);
      element.shadowRoot!.querySelector(".cm-content")!.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: clipboard,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
      expect(element.value).toBe("left copiedright");
    } finally {
      source.destroy();
    }
  });

  it("normalizes a history-restored chip before a subsequent paste", async () => {
    const { userEvent } = await import("vitest/browser");
    const element = editor("");
    element.resolveChips = (value, context) =>
      value === "$weather" && !context.editing
        ? [{ kind: "skill", start: 0, end: 8, label: "Weather" }]
        : [];
    element.focus();
    await userEvent.keyboard("$weather");
    element.setSelectionRange(6, 6);
    await userEvent.keyboard("X");
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(element.value).toBe("$weather");
    expect(element.selectionStart).toBe(8);
    await userEvent.keyboard("{Control>}y{/Control}");
    expect(element.value).toBe("$weathXer");
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(element.selectionStart).toBe(8);
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", " after");
    element.shadowRoot!.querySelector(".cm-content")!.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: clipboard,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    expect(element.value).toBe("$weather after");
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(element.value).toBe("$weather");
  });

  it("reveals the pasted caret in a height-capped composer", async () => {
    const element = editor(Array.from({ length: 20 }, (_, index) => `Line ${index}`).join("\n"));
    element.style.cssText = "height: 80px; overflow: auto; font: 16px / 24px sans-serif";
    element.focus();
    element.scrollTop = 0;
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "\nPasted last line");
    element.shadowRoot!.querySelector(".cm-content")!.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: clipboard,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    await expect.poll(() => element.scrollTop).toBeGreaterThan(0);
    await expect
      .poll(() => element.coordsAtPos(element.selectionEnd)?.bottom ?? Infinity)
      .toBeLessThanOrEqual(element.getBoundingClientRect().bottom);
  });

  it("fits a long chip inside a narrow composer rather than the viewport", () => {
    const element = editor("$weather");
    element.style.cssText =
      "width: 180px; font: 16px / 24px sans-serif; --accent: rgb(10, 80, 160)";
    element.resolveChips = () => [
      {
        kind: "skill",
        start: 0,
        end: 8,
        label: "A very long installed skill label that exceeds a narrow split pane",
      },
    ];
    const chip = element.shadowRoot!.querySelector<HTMLElement>(".composer-chip")!;
    const label = element.shadowRoot!.querySelector<HTMLElement>(".composer-chip__label")!;
    expect(element.clientWidth).toBe(180);
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
    expect(
      chip.getBoundingClientRect().right + Number.parseFloat(getComputedStyle(chip).marginRight),
    ).toBeLessThanOrEqual(element.getBoundingClientRect().right);
    expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    expect(element.value).toBe("$weather");
  });

  it.each([390, 1280])("aligns photo, initials and skill chips at %ipx", async (width) => {
    const { page } = await import("vitest/browser");
    await page.viewport(width, 900);
    const photo = document.createElement("canvas");
    photo.width = photo.height = 16;
    const context = photo.getContext("2d")!;
    context.fillStyle = "steelblue";
    context.fillRect(0, 0, 16, 16);
    const element = editor("@avery @blair $score");
    element.style.cssText = "font: 16px / 24px sans-serif; --accent: rgb(10, 80, 160)";
    element.resolveChips = () => [
      {
        kind: "mention",
        start: 0,
        end: 6,
        label: "Avery",
        avatarUrl: photo.toDataURL(),
      },
      {
        kind: "mention",
        start: 7,
        end: 13,
        label: "Blair",
        icon: html`<span
          style="display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; font: bold 8px / 1 sans-serif"
          >BR</span
        >`,
      },
      { kind: "skill", start: 14, end: 20, label: "Score", icon: icons.pencilSparkles },
    ];
    await expect
      .poll(
        () =>
          element.shadowRoot!.querySelector<HTMLImageElement>(".composer-chip__icon img")!
            .naturalWidth,
      )
      .toBeGreaterThan(0);
    const chips = [...element.shadowRoot!.querySelectorAll<HTMLElement>(".composer-chip")];
    expect(chips).toHaveLength(3);
    const first = chips[0]!.getBoundingClientRect();
    const firstLabel = chips[0]!.querySelector("bdi")!.getBoundingClientRect();
    for (const chip of chips) {
      const rect = chip.getBoundingClientRect();
      const label = chip.querySelector("bdi")!.getBoundingClientRect();
      const icon = chip.querySelector(".composer-chip__icon")!.getBoundingClientRect();
      expect(Math.abs(rect.top - first.top)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(label.top - firstLabel.top)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(rect.height - first.height)).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(icon.top + icon.height / 2 - (rect.top + rect.height / 2)),
      ).toBeLessThanOrEqual(0.5);
    }
  });

  it("preserves browser writing-assistance defaults", () => {
    const element = editor("");
    const content = element.shadowRoot!.querySelector<HTMLElement>(".cm-content")!;
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    expect(content.spellcheck).toBe(textarea.spellcheck);
    expect(content.autocorrect).toBe(textarea.autocorrect);
    expect(content.autocapitalize).toBe(textarea.autocapitalize);
  });

  it("preserves raw selection replacement and disconnect/reconnect state", () => {
    const element = editor();
    element.setSelectionRange(4, 12);
    element.setRangeText("@alex", 4, 12, "select");
    element.resolveChips = (value) => {
      const start = value.indexOf("@alex");
      return start < 0 ? [] : [{ kind: "mention", start, end: start + 5, label: "Alex" }];
    };
    expect(element.value).toBe("Use @alex now");
    expect(element.selectionStart).toBe(4);
    expect(element.selectionEnd).toBe(9);
    expect(element.shadowRoot!.querySelector(".composer-chip")?.getAttribute("aria-label")).toBe(
      "mention: Alex",
    );
    element.remove();
    document.body.append(element);
    expect(element.value).toBe("Use @alex now");
    expect(element.selectionStart).toBe(4);
    expect(element.selectionEnd).toBe(9);
  });
});
