/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import {
  composerFixture,
  mention,
  resetMentionComposerFixture,
} from "./chat-composer-mentions.test-support.ts";

afterEach(resetMentionComposerFixture);

describe.each(["chat", "new-session"] as const)("%s inline human mentions", (kind) => {
  it("paints distinct recipients inline without a second accessible editor or notification strip", () => {
    const view = composerFixture(kind, "Ask @Alex and @Alex", [
      mention("alex-one", 4, 9),
      mention("alex-two", 14, 19),
    ]);
    const textarea = view.query("textarea") as HTMLTextAreaElement;
    const layer = view.query(".chat-composer-mention-layer")!;
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.querySelectorAll(".markdown-person-reference__avatar")).toHaveLength(2);
    expect(
      Array.from(
        layer.querySelectorAll<HTMLElement>(".chat-composer-mention"),
        (node) => node.dataset.profileId,
      ),
    ).toEqual(["alex-one", "alex-two"]);
    expect(layer.textContent).toBe("Ask @Alex and @Alex​");
    expect(view.query(".chat-compose__mention-preview")).toBeNull();
    expect(view.container.textContent).not.toContain("Will notify");
    expect(view.query("[contenteditable]")).toBeNull();
    expect(textarea.value).toBe("Ask @Alex and @Alex");
    textarea.focus();
    textarea.setSelectionRange(6, 17, "backward");
    view.refresh();
    expect(view.query("textarea")).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual([
      6,
      17,
      "backward",
    ]);
  });

  it("follows authoritative ranges through edits without reassigning identical labels", () => {
    const view = composerFixture(kind, "@Alex and @Alex", [
      mention("alex-one"),
      mention("alex-two", 10, 15),
    ]);
    view.edit("Hi @Alex and @Alex", { start: 0, end: 0, caret: 3, data: "Hi " });
    view.expectValue("Hi @Alex and @Alex", [
      mention("alex-one", 3, 8),
      mention("alex-two", 13, 18),
    ]);
    view.edit("Hi @Aex and @Alex", {
      start: 5,
      end: 6,
      caret: 5,
      inputType: "deleteContentForward",
      data: null,
    });
    view.expectValue("Hi @Aex and @Alex", [mention("alex-two", 12, 17)]);
    const recipients = view.container.querySelectorAll<HTMLElement>(".chat-composer-mention");
    expect(recipients).toHaveLength(1);
    expect(recipients[0]?.dataset.profileId).toBe("alex-two");
  });

  it("keeps pasted markup literal and does not infer notification recipients from matching text", () => {
    const view = composerFixture(kind, "@Alex", [mention("alex-one")]);
    view.edit("<b>@Alex</b>", { start: 0, end: 5, inputType: "insertFromPaste" });
    view.expectValue("<b>@Alex</b>", []);
    expect((view.query("textarea") as HTMLTextAreaElement).value).toBe("<b>@Alex</b>");
    expect(view.query(".chat-composer-mention-layer")).toBeNull();
    expect(view.query("b")).toBeNull();
  });

  it("leaves the native composition preview and caret under IME ownership", () => {
    const view = composerFixture(kind, "@Alex ", [mention("alex-one")]);
    const textarea = view.query("textarea") as HTMLTextAreaElement;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "@Alex に";
    textarea.setSelectionRange(7, 7);
    textarea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        isComposing: true,
        inputType: "insertCompositionText",
        data: "に",
      }),
    );
    view.refresh();
    expect(textarea.hasAttribute("data-composing")).toBe(true);
    expect(textarea.value).toBe("@Alex に");
    expect(textarea.selectionStart).toBe(7);
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "に" }));
    view.refresh();
    expect(textarea.hasAttribute("data-composing")).toBe(false);
    expect(textarea.value).toBe("@Alex に");
  });

  it("mirrors the native scroll position without replacing the input", () => {
    const view = composerFixture(kind, "@Alex\n".repeat(12), [mention("alex-one")]);
    const textarea = view.query("textarea") as HTMLTextAreaElement;
    textarea.scrollTop = 85;
    textarea.scrollLeft = 12;
    textarea.dispatchEvent(new Event("scroll"));
    const layer = view.query(".chat-composer-mention-layer")!;
    expect(layer.scrollTop).toBe(85);
    expect(layer.scrollLeft).toBe(12);
    expect(view.query("textarea")).toBe(textarea);
  });
});
