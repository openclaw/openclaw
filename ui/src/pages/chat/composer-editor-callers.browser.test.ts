import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../../test-helpers/load-styles.ts";
import { focusComposerInput, selectComposerInput } from "../../lib/composer-input.ts";
import {
  composerFixture,
  mention,
  resetMentionComposerFixture,
} from "./chat-composer-mentions.test-support.ts";

afterEach(resetMentionComposerFixture);
describe.each(["chat", "new-session"] as const)(
  "%s rich composer controller integration",
  (kind) => {
    it.each(["@Bo", "@Bob "])(
      "undoes and redoes the first person selected from %s",
      async (query) => {
        const f = composerFixture(kind, "", []);
        vi.useRealTimers();
        f.request.mockResolvedValue({
          users: [{ profileId: "bob", displayName: "Bob", online: true }],
          truncated: false,
        });
        const input = f.query("textarea") as HTMLTextAreaElement;
        input.focus();
        await userEvent.keyboard(query);
        f.refresh();
        await expect
          .poll(() => document.querySelector('[role="option"]')?.textContent ?? "")
          .toContain("Bob");
        await userEvent.keyboard("{Enter}");
        f.refresh();
        await expect.poll(() => f.query('[data-composer-editor="true"]')).not.toBeNull();
        focusComposerInput(input);
        await userEvent.keyboard("{Control>}z{/Control}");
        f.refresh();
        expect(f.value()).toEqual({ draft: query, mentions: [] });
        await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
        f.refresh();
        expect(f.value()).toEqual({ draft: "@Bob ", mentions: [mention("bob", 0, 4)] });
      },
    );

    it("does not turn a restored selected draft into a new undoable insertion", async () => {
      const f = composerFixture(kind, "@Alex", [mention("alex-one", 0, 5)]);
      vi.useRealTimers();
      await expect.poll(() => f.query('[data-composer-editor="true"]')).not.toBeNull();
      focusComposerInput(f.query("textarea") as HTMLTextAreaElement);
      await userEvent.keyboard("{Control>}z{/Control}");
      f.refresh();
      expect(f.value()).toEqual({ draft: "@Alex", mentions: [mention("alex-one", 0, 5)] });
    });

    it("pastes a recipient into a fresh native composer before the editor loads", async () => {
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
      f.refresh();
      expect(f.value()).toEqual({ draft: "@Alex", mentions: [mention("alex-one", 0, 5)] });
      await expect.poll(() => f.query(".chat-composer-mention")?.textContent).toContain("Alex");
      expect(input.hidden).toBe(true);
      focusComposerInput(input);
      await userEvent.keyboard("{Control>}z{/Control}");
      f.refresh();
      expect(f.value()).toEqual({ draft: "", mentions: [] });
      await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
      f.refresh();
      expect(f.value()).toEqual({ draft: "@Alex", mentions: [mention("alex-one", 0, 5)] });
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
    it("inserts a second person through the real picker while retaining CM focus and raw offsets", async () => {
      const f = composerFixture(kind, "Ask @Alex after", [mention("alex-one", 4, 9)]);
      vi.useRealTimers();
      await expect.poll(() => f.query('[data-composer-editor="true"]')).not.toBeNull();
      f.request.mockResolvedValue({
        users: [{ profileId: "bob", displayName: "Bob", online: true }],
        truncated: false,
      });
      const input = f.query("textarea") as HTMLTextAreaElement;
      focusComposerInput(input);
      selectComposerInput(input, input.value.length, input.value.length);
      await userEvent.keyboard(" @Bo");
      f.refresh();
      expect(f.value().draft).toBe("Ask @Alex after @Bo");
      await expect
        .poll(() => document.querySelector('[role="option"]')?.textContent ?? "", { timeout: 5000 })
        .toContain("Bob");
      await userEvent.keyboard("{Enter}");
      f.refresh();
      await expect
        .poll(() => f.value().mentions.some((person) => person.profileId === "bob"))
        .toBe(true);
      // This fixture projects its plain owner explicitly; production callers
      // receive the same committed draft through their live owner projection.
      f.refresh();
      await expect
        .poll(() =>
          [...f.container.querySelectorAll(".chat-composer-mention")]
            .map((label) => label.textContent)
            .join(" "),
        )
        .toContain("Bob");
      const picked = f.value();
      const bob = picked.mentions.find((person) => person.profileId === "bob")!;
      expect(picked.draft.slice(bob.start, bob.end)).toBe("@Bob");
      expect(picked.draft).toBe("Ask @Alex after @Bob ");
      await expect
        .poll(() => f.query('[data-composer-editor="true"]')?.contains(document.activeElement))
        .toBe(true);
      await userEvent.keyboard("done");
      f.refresh();
      expect(f.value().draft).toBe("Ask @Alex after @Bob done");
    });
  },
);
