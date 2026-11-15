import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { cdp, userEvent } from "vitest/browser";
import "../../test-helpers/load-styles.ts";
import { focusComposerInput, selectComposerInput } from "../../lib/composer-input.ts";
import {
  composerFixture,
  mention,
  resetMentionComposerFixture,
} from "./chat-composer-mentions.test-support.ts";
import { mountMentionComposerEditor } from "./components/composer-editor-mentions.tsx";

afterEach(resetMentionComposerFixture);

function richDragData() {
  const host = document.createElement("div");
  const input = document.createElement("textarea");
  input.value = "@Alex";
  host.append(input);
  document.body.append(host);
  const editor = mountMentionComposerEditor(input, () => [mention("alex-one")]);
  onTestFinished(() => {
    editor.destroy();
    host.remove();
  });
  selectComposerInput(input, 0, 5);
  const transfer = new DataTransfer();
  // Obtain metadata from the real rich source handler; CDP below drives the
  // browser's native destination pipeline, not synthetic default insertion.
  host.querySelector("[data-composer-editor]")!.dispatchEvent(
    new DragEvent("dragstart", {
      bubbles: true,
      dataTransfer: transfer,
    }),
  );
  expect(transfer.getData("application/x-openclaw-mentions")).not.toBe("");
  return {
    dragOperationsMask: 1,
    items: [...transfer.types].map((mimeType) => ({ mimeType, data: transfer.getData(mimeType) })),
  };
}

async function nativeDrop(
  input: HTMLTextAreaElement,
  position: number,
  data: ReturnType<typeof richDragData>,
) {
  input.style.cssText = "font:16px/24px monospace; padding:0; border:0; width:400px; height:80px";
  input.scrollIntoView();
  input.focus();
  // A deliberately different selection proves the browser resolves the caret.
  input.setSelectionRange(input.value.length, input.value.length);
  const context = document.createElement("canvas").getContext("2d")!;
  context.font = "16px monospace";
  const rect = input.getBoundingClientRect();
  const x = rect.left + context.measureText(input.value.slice(0, position)).width + 1;
  const session = cdp();
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await session.send("Input.dispatchDragEvent", { type, x, y: rect.top + 12, data });
  }
}

for (const kind of ["chat", "new-session"] as const) {
  it.each(["", "helloWorld"])(
    "preserves first dropped recipient and undo history in " + kind + " (%s)",
    async (initial) => {
      const f = composerFixture(kind, initial, []);
      vi.useRealTimers();
      const input = f.query("textarea") as HTMLTextAreaElement;
      expect(f.query("[data-composer-editor]")).toBeNull();
      const beforeInputs: { trusted: boolean; start: number; end: number; inputType: string }[] =
        [];
      input.addEventListener(
        "beforeinput",
        (event) =>
          beforeInputs.push({
            trusted: event.isTrusted,
            start: input.selectionStart,
            end: input.selectionEnd,
            inputType: event.inputType,
          }),
        { capture: true },
      );
      await nativeDrop(input, initial ? 5 : 0, richDragData());
      expect(beforeInputs).toEqual([
        {
          trusted: true,
          start: initial ? 5 : 0,
          end: initial ? 5 : 0,
          inputType: "insertFromDrop",
        },
      ]);
      const after = initial
        ? { draft: "hello @Alex World", mentions: [mention("alex-one", 6, 11)] }
        : { draft: "@Alex", mentions: [mention("alex-one")] };
      // The drop mounts the editor, which then performs the insertion.
      await expect.poll(() => f.value()).toEqual(after);
      f.refresh();
      await expect.poll(() => f.query(".chat-composer-mention")?.textContent).toContain("Alex");
      expect(input.hidden).toBe(true);
      focusComposerInput(input);
      await userEvent.keyboard("{Control>}z{/Control}");
      f.refresh();
      expect(f.value()).toEqual({ draft: initial, mentions: [] });
      await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
      f.refresh();
      expect(f.value()).toEqual(after);
    },
  );

  it("leaves plain native text drops unchanged in " + kind, async () => {
    const f = composerFixture(kind, "helloWorld", []);
    vi.useRealTimers();
    const input = f.query("textarea") as HTMLTextAreaElement;
    await nativeDrop(input, 5, {
      dragOperationsMask: 1,
      items: [{ mimeType: "text/plain", data: "@Alex" }],
    });
    f.refresh();
    expect(f.value()).toEqual({ draft: "hello@AlexWorld", mentions: [] });
    expect(f.query("[data-composer-editor]")).toBeNull();
  });
}
