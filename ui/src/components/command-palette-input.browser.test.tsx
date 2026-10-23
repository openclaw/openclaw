import { createSignal, type ComponentProps } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextFrame } from "../test-helpers/modal-dialog.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import "../styles.css";
import { CommandPaletteInput } from "./command-palette-input.tsx";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

describe.skipIf(!hasBrowserLayout)("command palette input layout", () => {
  type InputProps = ComponentProps<typeof CommandPaletteInput>;
  const edit = (input: HTMLTextAreaElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const expectFades = (entry: Element, top: boolean, bottom: boolean) =>
    expect(["top", "bottom"].map((edge) => entry.hasAttribute("data-scroll-fade-" + edge))).toEqual(
      [top, bottom],
    );
  const threeFrames = async () => {
    for (let frame = 0; frame < 3; frame++) {
      await nextFrame();
    }
  };
  function mountInput(
    value: string,
    extra: Partial<InputProps> = {},
    css = "width: 740px; max-width: 100%;",
  ) {
    const props: InputProps = {
      value,
      placeholder: "Search or start a task…",
      onInputRef: () => undefined,
      onValueChange: (next) => {
        props.value = next;
      },
      ...extra,
    };
    const [current, setCurrent] = createSignal(props);
    const { container: host } = mountSolid(() => <CommandPaletteInput {...current()} />);
    host.style.cssText = css;
    flush();
    return {
      host,
      props,
      input: host.querySelector("textarea")!,
      entry: host.querySelector<HTMLElement>(".cmd-palette__entry")!,
      renderInput: (next: InputProps) => {
        setCurrent(() => next);
        flush();
      },
    };
  }
  afterEach(() => vi.restoreAllMocks());

  it("preserves the prompt without remeasuring result navigation and measures again on reconnect", async () => {
    // A fixed width/font makes reconnection cross a wrapping boundary.
    const { host, input, props, renderInput } = mountInput(
      "Keep this prompt and its caret while changing preferences.",
      { actions: <button type="button">Settings</button> },
      "width: 740px; font-family: monospace;",
    );
    await document.fonts.ready;
    // ResizeObserver's initial delivery schedules another layout frame.
    await threeFrames();
    const originalHeight = input.clientHeight;
    expect([host.clientWidth, originalHeight]).toEqual([740, 24]);
    const measureContent = vi.spyOn(input, "scrollHeight", "get");
    const settings = host.querySelector("button")!;
    input.focus();
    input.setSelectionRange(5, 11, "backward");
    settings.focus();
    renderInput({ ...props, activeDescendant: "next-result" });
    await nextFrame();
    expect(document.activeElement).toBe(settings);
    expect(input).toMatchObject({
      value: props.value,
      selectionStart: 5,
      selectionEnd: 11,
      selectionDirection: "backward",
    });
    expect(measureContent).not.toHaveBeenCalled();
    expect(input.clientHeight).toBe(originalHeight);

    host.remove();
    host.style.width = "320px";
    document.body.append(host);
    await vi.waitFor(() => expect(input.clientHeight).toBeGreaterThan(originalHeight));
    expect(measureContent).toHaveBeenCalled();
    expect(input.value).toBe(props.value);
  });

  it("keeps a scrolled prompt in place through rerenders and resizing until the user edits", async () => {
    const { host, input, entry, props, renderInput } = mountInput(
      Array.from({ length: 12 }, (_, index) => "Prompt line " + (index + 1)).join("\n"),
    );
    await vi.waitFor(() => expect(input.style.overflowY).toBe("auto"));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollTop = 22;
    input.dispatchEvent(new Event("scroll"));
    const previousScroll = input.scrollTop;

    renderInput({ ...props, activeDescendant: "next-result" });
    await nextFrame();
    expect(input.scrollTop).toBe(previousScroll);
    expectFades(entry, true, true);

    host.style.width = "500px";
    await new Promise<void>((resolve) => {
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        requestAnimationFrame(() => resolve());
      });
      observer.observe(entry);
    });
    expect(input).toMatchObject({ scrollTop: previousScroll, selectionEnd: props.value.length });

    edit(input, input.value + "\nContinue writing");
    renderInput(props);
    await nextFrame();
    expect(input.scrollTop).toBe(input.scrollHeight - input.clientHeight);
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(false);

    input.setSelectionRange(0, 0);
    input.scrollTop = 0;
    input.setRangeText("Edit the beginning: ", 0, 0, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    renderInput(props);
    await nextFrame();
    expect(input.scrollTop).toBe(0);
  });

  it("grows down through three lines, keeps actions fixed and fades clear of the far-right scrollbar", async () => {
    const { host, input, entry } = mountInput("One line", {
      actions: (
        <button type="button" class="cmd-palette__create">
          New session<kbd>Ctrl+Enter</kbd>
        </button>
      ),
    });
    const actions = host.querySelector<HTMLElement>(".cmd-palette__input-actions")!;
    const textScroll = host.querySelector<HTMLElement>(".cmd-palette__input-scroll")!;
    await nextFrame();
    edit(input, input.value);
    const top = input.getBoundingClientRect().top;
    const actionTop = actions.getBoundingClientRect().top;
    const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight);
    expect(input.clientHeight).toBe(24);

    for (const lines of [2, 5]) {
      edit(input, Array(lines).fill("Prompt line").join("\n"));
      expect([
        input.clientHeight,
        input.getBoundingClientRect().top,
        actions.getBoundingClientRect().top,
      ]).toEqual([lineHeight * Math.min(lines, 3), top, actionTop]);
    }
    const inputRect = input.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const inputStyle = getComputedStyle(input);
    expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
    expect(inputStyle.overflowY).toBe("auto");
    expect(inputStyle.scrollbarWidth).not.toBe("none");
    expect(inputRect.right).toBeGreaterThan(actionsRect.right + 8);
    expect(inputRect.right - Number.parseFloat(inputStyle.paddingRight)).toBeLessThan(
      actionsRect.left,
    );
    const fadeRight =
      textScroll.getBoundingClientRect().right -
      Number.parseFloat(getComputedStyle(textScroll, "::after").right);
    expect(fadeRight).toBeLessThan(actionsRect.left);
    // Autofocus keeps an edited caret visible; explicitly inspect the top edge.
    for (const scrollTop of [0, input.scrollHeight, 0]) {
      input.scrollTop = scrollTop;
      input.dispatchEvent(new Event("scroll"));
      expectFades(entry, scrollTop > 0, scrollTop === 0);
    }

    edit(input, "A short task");
    expect(input.clientHeight).toBe(24);
    expectFades(entry, false, false);
    expect(input.getBoundingClientRect().top).toBe(top);

    edit(input, "A wrapping task with enough text to grow after the available width changes.");
    host.style.width = "320px";
    await vi.waitFor(() => expect(input.clientHeight).toBe(lineHeight * 3));
    expect(actions.getBoundingClientRect().top).toBe(actionTop);

    await document.fonts.ready;
    const styleChanges: MutationRecord[] = [];
    const observer = new MutationObserver((records) => styleChanges.push(...records));
    observer.observe(input, { attributes: true, attributeFilter: ["style"] });
    try {
      // ResizeObserver can enqueue more frames; require a quiet three-frame window.
      await vi.waitFor(
        async () => {
          styleChanges.length = 0;
          await threeFrames();
          expect(styleChanges).toEqual([]);
        },
        { timeout: 5_000 },
      );
      edit(input, "One line");
      observer.takeRecords();
      await threeFrames();
      expect(styleChanges).toEqual([]);
    } finally {
      observer.disconnect();
    }
  });
});
