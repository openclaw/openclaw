import { Text } from "@codemirror/state";
import { expectDefined } from "@openclaw/normalization-core";
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import {
  focusComposerInput,
  readComposerEditor,
  selectComposerInput,
} from "../../lib/composer-input.ts";
import { isApplePlatform } from "../../lib/keyboard-shortcut-contract.ts";
import "../../test-helpers/load-styles.ts";
import { createMentionComposerBinding } from "../../lib/reactive/composer-editor.ts";
import {
  composerFixture,
  mention,
  resetMentionComposerFixture,
} from "./chat-composer-mentions.test-support.ts";

const historyModifier = isApplePlatform() ? "Meta" : "Control";

// Count the validator's label scan without replacing a shared module export.
function countRecipientReads(text: string, action: () => void) {
  const scan = vi.spyOn(String.prototype, "charCodeAt");
  const stringify = vi.spyOn(Text.prototype, "toString");
  try {
    action();
    return {
      serializations: stringify.mock.results.filter((result) => result.value === text).length,
      scannedOffsets: scan.mock.calls.flatMap(([offset], index) =>
        scan.mock.contexts[index] === text ? [offset] : [],
      ),
    };
  } finally {
    scan.mockRestore();
    stringify.mockRestore();
  }
}

afterEach(resetMentionComposerFixture);
describe.each(["chat", "new-session"] as const)(
  "%s rich composer controller integration",
  (kind) => {
    it("keeps real rich scrolling without synthetic native scroll or unused fades", async () => {
      const f = composerFixture(kind, "@Alex\n" + "A long draft line.\n".repeat(40), [
        mention("alex-one", 0, 5),
      ]);
      vi.useRealTimers();
      await expect.poll(() => f.query('[data-composer-editor="true"]')).not.toBeNull();
      const input = f.query("textarea") as HTMLTextAreaElement;
      const editor = readComposerEditor(input)!;
      const port = editor.scrollElement;
      await expect.poll(() => port.scrollHeight > port.clientHeight).toBe(true);
      const writes = [
        vi.spyOn(input, "toggleAttribute"),
        vi.spyOn(editor.element, "toggleAttribute"),
      ];
      const dispatch = vi.spyOn(input, "dispatchEvent");
      const scroll = vi.fn<(event: Event) => void>();
      port.addEventListener("scroll", scroll);
      port.scrollTop = 0;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      for (const fraction of [1, 0]) {
        scroll.mockClear();
        port.scrollTop = (port.scrollHeight - port.clientHeight) * fraction;
        await expect.poll(() => scroll.mock.calls.some(([event]) => event.isTrusted)).toBe(true);
        expect(input.hidden).toBe(true);
        expect(input.hasAttribute("data-composer-overflow")).toBe(true);
        expect(editor.element.hasAttribute("data-composer-overflow")).toBe(true);
        expect(getComputedStyle(editor.element).maskImage).toBe("none");
        expect(getComputedStyle(port).maskImage).toBe("none");
      }
      const fadeWrites = writes.flatMap((spy) =>
        spy.mock.calls.filter(([name]) => name.startsWith("data-scroll-fade-")),
      );
      writes.forEach((spy) => spy.mockRestore());
      expect(fadeWrites).toEqual([]);
      expect(dispatch.mock.calls.filter(([event]) => event.type === "scroll")).toEqual([]);
      focusComposerInput(input);
      selectComposerInput(input, input.value.length, input.value.length);
      await userEvent.keyboard(":smi");
      f.refresh();
      await expect
        .poll(() => document.querySelector('[aria-label="Emoji suggestions"]'))
        .not.toBeNull();
      await expect.poll(() => input.hasAttribute("aria-activedescendant")).toBe(true);
      expect(port.scrollTop).toBeGreaterThan(0);
      port.scrollTop = 0;
      await expect.poll(() => input.hasAttribute("aria-activedescendant")).toBe(false);
      port.removeEventListener("scroll", scroll);
    });

    it("retains native fades and refreshes rich overflow after restores, edits and width changes", async () => {
      const long = "@Alex\n" + "A long draft line.\n".repeat(40);
      const f = composerFixture(kind, long);
      vi.useRealTimers();
      const input = f.query("textarea") as HTMLTextAreaElement;
      expect(input.hidden).toBe(false);
      await expect.poll(() => input.scrollHeight > input.clientHeight).toBe(true);
      input.scrollTop = input.scrollHeight;
      await expect
        .poll(() => [
          input.hasAttribute("data-scroll-fade-top"),
          input.hasAttribute("data-scroll-fade-bottom"),
        ])
        .toEqual([true, false]);
      input.scrollTop = 0;
      await expect
        .poll(() => [
          input.hasAttribute("data-scroll-fade-top"),
          input.hasAttribute("data-scroll-fade-bottom"),
        ])
        .toEqual([false, true]);
      f.restoreDraft(long, [mention("alex-one", 0, 5)]);
      await expect.poll(() => readComposerEditor(input)).toBeDefined();
      const editor = readComposerEditor(input)!;
      const port = editor.scrollElement;
      const overflow = (expected: boolean) =>
        expect
          .poll(() => [
            port.scrollHeight > port.clientHeight + 1,
            input.hasAttribute("data-composer-overflow"),
            editor.element.hasAttribute("data-composer-overflow"),
          ])
          .toEqual([expected, expected, expected]);
      await overflow(true);
      const beforeEditRead = vi.spyOn(port, "scrollHeight", "get");
      try {
        editor.focusElement.dispatchEvent(
          new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "x" }),
        );
        expect(beforeEditRead).not.toHaveBeenCalled();
      } finally {
        beforeEditRead.mockRestore();
      }
      f.restoreDraft("@Alex", [mention("alex-one", 0, 5)]);
      await overflow(false);
      focusComposerInput(input);
      selectComposerInput(input, 5, 5);
      await userEvent.keyboard("line{Shift>}{Enter}{/Shift}".repeat(12));
      f.refresh();
      await overflow(true);
      selectComposerInput(input, 5, input.value.length);
      await userEvent.keyboard("{Backspace}");
      f.refresh();
      await overflow(false);
      const surface = f.query(".agent-chat__input") as HTMLElement;
      surface.style.width = "320px";
      f.restoreDraft("@Alex " + "wrapped words ".repeat(32), [mention("alex-one", 0, 5)]);
      await overflow(true);
      surface.style.width = "1200px";
      await overflow(false);
      surface.style.width = "320px";
      await overflow(true);
    });

    it("validates recipients once at the rich synchronization boundary", async () => {
      const recipients = [mention("alex-one", 0, 5)];
      const f = composerFixture(kind, "@Alex", recipients);
      vi.useRealTimers();
      await expect.poll(() => f.query('[data-composer-editor="true"]')).not.toBeNull();
      const input = f.query("textarea") as HTMLTextAreaElement;
      const editor = readComposerEditor(input)!;
      const { serializations, scannedOffsets } = countRecipientReads("@Alex", () => editor.sync());
      expect(serializations).toBe(1);
      expect(scannedOffsets).toEqual([0, 1, 2, 3, 4]);
      expect(f.query(".chat-composer-mention")?.textContent).toContain("Alex");

      recipients.push(mention("overlapping", 0, 5));
      editor.sync();
      expect(f.query(".chat-composer-mention")).toBeNull();
      recipients.splice(0, recipients.length, mention("alex-two", 0, 5));
      editor.sync();
      expect(f.query(".chat-composer-mention")?.getAttribute("data-profile-id")).toBe("alex-two");
    });

    it("does not rescan mapped recipients for an empty rich restoration", async () => {
      const f = composerFixture(kind, "@Alex", [mention("alex-one", 0, 5)]);
      vi.useRealTimers();
      await expect.poll(() => f.query('[data-composer-editor="true"]')).not.toBeNull();
      const input = f.query("textarea") as HTMLTextAreaElement;
      const { serializations, scannedOffsets } = countRecipientReads("@Alex!", () =>
        readComposerEditor(input)!.replace("!", 5, 5),
      );
      expect(serializations).toBe(1);
      expect(scannedOffsets).toEqual([0, 1, 2, 3, 4]);
      expect(f.value()).toEqual({ draft: "@Alex!", mentions: [mention("alex-one", 0, 5)] });
      expect(f.query(".chat-composer-mention")?.getAttribute("data-profile-id")).toBe("alex-one");
    });

    it.each([
      ["@Bo", false],
      ["@Bob ", false],
      ["@Bo", true],
      ["@Bob ", true],
    ] as const)(
      "undoes and redoes a person selected from %s (existing mention: %s)",
      async (query, existing) => {
        const prefix = existing ? "Ask @Alex after " : "";
        const f = composerFixture(
          kind,
          prefix.trimEnd(),
          existing ? [mention("alex-one", 4, 9)] : [],
        );
        vi.useRealTimers();
        if (existing) {
          await expect.poll(() => f.query('[data-composer-editor="true"]')).not.toBeNull();
        }
        f.request.mockResolvedValue({
          users: [{ profileId: "bob", displayName: "Bob", online: true }],
          truncated: false,
        });
        const input = f.query("textarea") as HTMLTextAreaElement;
        focusComposerInput(input);
        selectComposerInput(input, input.value.length, input.value.length);
        await userEvent.keyboard((existing ? " " : "") + query);
        f.refresh();
        const beforePick = f.value();
        expect(beforePick.draft).toBe(prefix + query);
        await expect
          .poll(() => document.querySelector('[role="option"]')?.textContent ?? "")
          .toContain("Bob");
        await userEvent.keyboard("{Enter}");
        f.refresh();
        await expect.poll(() => f.query('[data-composer-editor="true"]')).not.toBeNull();
        await expect
          .poll(() => f.value().mentions.some((person) => person.profileId === "bob"))
          .toBe(true);
        // Project the committed owner before checking the retained editor.
        f.refresh();
        await expect
          .poll(() =>
            [...f.container.querySelectorAll(".chat-composer-mention")]
              .map((label) => label.textContent)
              .join(" "),
          )
          .toContain("Bob");
        const picked = f.value();
        expect(picked).toEqual({
          draft: prefix + "@Bob ",
          mentions: [
            ...(existing ? [mention("alex-one", 4, 9)] : []),
            mention("bob", prefix.length, prefix.length + 4),
          ],
        });
        await expect
          .poll(() => f.query('[data-composer-editor="true"]')?.contains(document.activeElement))
          .toBe(true);
        await userEvent.keyboard(`{${historyModifier}>}z{/${historyModifier}}`);
        f.refresh();
        expect(f.value()).toEqual(beforePick);
        await userEvent.keyboard(`{${historyModifier}>}{Shift>}Z{/Shift}{/${historyModifier}}`);
        f.refresh();
        expect(f.value()).toEqual(picked);
        selectComposerInput(input, picked.draft.length, picked.draft.length);
        await userEvent.keyboard("done");
        f.refresh();
        expect(f.value().draft).toBe(prefix + "@Bob done");
      },
    );

    it("does not turn a restored selected draft into a new undoable insertion", async () => {
      const f = composerFixture(kind, "@Alex", [mention("alex-one", 0, 5)]);
      vi.useRealTimers();
      await expect.poll(() => f.query('[data-composer-editor="true"]')).not.toBeNull();
      focusComposerInput(f.query("textarea") as HTMLTextAreaElement);
      await userEvent.keyboard(`{${historyModifier}>}z{/${historyModifier}}`);
      f.refresh();
      expect(f.value()).toEqual({ draft: "@Alex", mentions: [mention("alex-one", 0, 5)] });
    });

    it("pastes plain text when the editor cannot mount, then binds recipients once it can", async () => {
      const f = composerFixture(kind, "", []);
      vi.useRealTimers();
      const input = f.query("textarea") as HTMLTextAreaElement;
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", "@Alex");
      clipboard.setData(
        "application/x-openclaw-mentions",
        JSON.stringify([mention("alex-one", 0, 5)]),
      );
      const paste = () =>
        input.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard,
          }),
        );
      // Fail before EditorView construction, not after allocating an orphan editor.
      const parent = vi.spyOn(input, "parentElement", "get").mockImplementation(() => {
        throw new Error("test mount unavailable");
      });
      try {
        paste();
        // No editor can show a recipient, so the visible text binds nobody.
        await expect.poll(() => f.value()).toEqual({ draft: "@Alex", mentions: [] });
        expect(parent).toHaveBeenCalled();
        expect(input.hidden).toBe(false);
        expect(readComposerEditor(input)).toBeUndefined();
      } finally {
        parent.mockRestore();
      }
      f.refresh();
      input.setSelectionRange(5, 5);
      paste();
      await expect
        .poll(() => f.value())
        .toEqual({ draft: "@Alex @Alex", mentions: [mention("alex-one", 6, 11)] });
      f.refresh();
      await expect
        .poll(() => f.container.querySelectorAll(".chat-composer-mention").length)
        .toBe(1);
      focusComposerInput(input);
      await userEvent.keyboard(`{${historyModifier}>}z{/${historyModifier}}`);
      f.refresh();
      expect(f.value()).toEqual({ draft: "@Alex", mentions: [] });
    });

    it("pastes recipients atomically before and after the editor loads", async () => {
      const f = composerFixture(kind, "", []);
      vi.useRealTimers();
      const input = f.query("textarea") as HTMLTextAreaElement;
      expect(input.hidden).toBe(false);
      expect(f.query('[data-composer-editor="true"]')).toBeNull();
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", "@Alex");
      clipboard.setData(
        "application/x-openclaw-mentions",
        JSON.stringify([mention("alex-one", 0, 5)]),
      );
      input.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
      );
      await expect
        .poll(() => f.value())
        .toEqual({ draft: "@Alex", mentions: [mention("alex-one", 0, 5)] });
      f.refresh();
      await expect.poll(() => f.query(".chat-composer-mention")?.textContent).toContain("Alex");
      expect(input.hidden).toBe(true);
      focusComposerInput(input);
      await userEvent.keyboard(`{${historyModifier}>}z{/${historyModifier}}`);
      f.refresh();
      expect(f.value()).toEqual({ draft: "", mentions: [] });
      await userEvent.keyboard(`{${historyModifier}>}{Shift>}Z{/Shift}{/${historyModifier}}`);
      f.refresh();
      expect(f.value()).toEqual({ draft: "@Alex", mentions: [mention("alex-one", 0, 5)] });
      selectComposerInput(input, input.value.length, input.value.length);
      const reads = vi.spyOn(clipboard, "getData");
      let metadataReads: number;
      try {
        f.query("[data-composer-editor]")!.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard,
          }),
        );
        metadataReads = reads.mock.calls.filter(
          ([type]) => type === "application/x-openclaw-mentions",
        ).length;
      } finally {
        reads.mockRestore();
      }
      expect(metadataReads).toBe(1);
      f.refresh();
      await expect
        .poll(() => f.container.querySelectorAll(".chat-composer-mention").length)
        .toBe(2);
      await userEvent.keyboard(`{${historyModifier}>}z{/${historyModifier}}`);
      f.refresh();
      expect(f.value()).toEqual({ draft: "@Alex", mentions: [mention("alex-one", 0, 5)] });
      await userEvent.keyboard(`{${historyModifier}>}{Shift>}Z{/Shift}{/${historyModifier}}`);
      f.refresh();
      expect(f.value()).toEqual({
        draft: "@Alex @Alex",
        mentions: [mention("alex-one", 0, 5), mention("alex-one", 6, 11)],
      });
    });

    it("edits like a textarea and keeps owner clears and over-limit pastes safe", async () => {
      const f = composerFixture(kind, "  @Alex", [mention("alex-one", 2, 7)]);
      vi.useRealTimers();
      await expect.poll(() => f.query('[data-composer-editor="true"]')).not.toBeNull();
      const content = f.query('[data-composer-editor="true"]')!;
      expect([content.getAttribute("spellcheck"), content.getAttribute("autocapitalize")]).toEqual([
        "true",
        "sentences",
      ]);
      const input = f.query("textarea") as HTMLTextAreaElement;
      focusComposerInput(input);
      selectComposerInput(input, 7, 7);
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
      f.refresh();
      expect(f.value().draft).toBe("  @Alex\n");
      // A send/discard clear is not an edit the user can undo back into the draft.
      f.restoreDraft("", []);
      await userEvent.keyboard(`{${historyModifier}>}z{/${historyModifier}}`);
      f.refresh();
      expect(f.value()).toEqual({ draft: "", mentions: [] });
      const six = Array.from({ length: 6 }, (_, index) =>
        mention("alex-one", index * 6, index * 6 + 5),
      );
      const text = Array.from({ length: 6 }, () => "@Alex").join(" ");
      f.restoreDraft(text, six);
      await expect
        .poll(() => f.container.querySelectorAll(".chat-composer-mention").length)
        .toBe(6);
      selectComposerInput(input, text.length, text.length);
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", text);
      clipboard.setData("application/x-openclaw-mentions", JSON.stringify(six));
      content.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
      );
      f.refresh();
      // Twelve would exceed the protocol limit; existing bindings survive and the rest stay text.
      expect(f.value().mentions).toHaveLength(10);
      expect(f.value().mentions?.slice(0, 6)).toEqual(six);
    });

    it("lazily mounts one real textbox and routes editing, selection and send through the existing owner", async () => {
      const f = composerFixture(kind, "Ask @Alex after", [mention("alex-one", 4, 9)]);
      vi.useRealTimers();
      await expect.poll(() => f.query('[data-composer-editor="true"]')).not.toBeNull();
      const input = f.query("textarea") as HTMLTextAreaElement;
      const editor = f.query('[data-composer-editor="true"]') as HTMLElement;
      expect(input.hidden).toBe(true);
      focusComposerInput(input);
      selectComposerInput(input, 0, 0);
      await userEvent.keyboard("Hello ");
      f.refresh();
      expect(f.value()).toEqual({
        draft: "Hello Ask @Alex after",
        mentions: [mention("alex-one", 10, 15)],
      });
      await expect.poll(() => f.query(".chat-composer-mention")?.textContent).toContain("Alex");
      expect(editor.contains(document.activeElement)).toBe(true);
      expect(input.selectionStart).toBe(6);
      await userEvent.keyboard("{Enter}");
      expect(f.send).toHaveBeenCalledWith({
        draft: "Hello Ask @Alex after",
        mentions: [mention("alex-one", 10, 15)],
      });
    });
  },
);

it("retires native activation frames after handoff and across ref replacement", async () => {
  let recipients = [mention("alex-one", 0, 5)];
  const getMentions = vi.fn(() => recipients);
  const binding = createRoot((dispose) => ({
    ref: createMentionComposerBinding(getMentions),
    dispose,
  }));
  const container = document.createElement("div");
  const first = document.createElement("textarea");
  first.value = "@Alex";
  container.append(first);
  document.body.append(container);
  onTestFinished(() => {
    binding.dispose();
    container.remove();
  });
  binding.ref(first);
  await expect.poll(() => readComposerEditor(first)).toBeDefined();
  const frames = vi.spyOn(window, "requestAnimationFrame");
  try {
    first.dispatchEvent(new CompositionEvent("compositionend"));
    expect(frames).not.toHaveBeenCalled();
  } finally {
    frames.mockRestore();
  }
  const next = document.createElement("textarea");
  container.append(next);
  recipients = [];
  binding.ref(next);
  expect(readComposerEditor(first)).toBeUndefined();
  next.dispatchEvent(new CompositionEvent("compositionstart"));
  next.value = "@Alex";
  recipients = [mention("alex-one", 0, 5)];
  next.setAttribute("aria-label", "Composing");
  await Promise.resolve();
  expect(next.hidden).toBe(false);
  const queued: FrameRequestCallback[] = [];
  const queue = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    queued.push(callback);
    return 0;
  });
  try {
    next.dispatchEvent(new CompositionEvent("compositionend"));
  } finally {
    queue.mockRestore();
  }
  expect(queued).toHaveLength(1);
  const replacement = document.createElement("textarea");
  container.append(replacement);
  recipients = [];
  binding.ref(replacement);
  getMentions.mockClear();
  expectDefined(queued[0], "deferred composition callback")(performance.now());
  expect(getMentions).not.toHaveBeenCalled();
  expect(readComposerEditor(next)).toBeUndefined();
  replacement.value = "@Alex";
  recipients = [mention("alex-one", 0, 5)];
  replacement.setAttribute("aria-label", "Replacement");
  await expect.poll(() => readComposerEditor(replacement)).toBeDefined();
});
