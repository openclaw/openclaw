import { render } from "lit";
import { describe, expect, it } from "vitest";
import { selectWorkingClawSurprise } from "./chat-working-indicator-surprise.ts";
import { renderChatWorkingIndicator } from "./chat-working-indicator.ts";

describe("renderChatWorkingIndicator", () => {
  it("selects the working glyph independently of the mascot and keeps text when hidden", () => {
    const container = document.createElement("div");
    const part = { kind: "reading-indicator" as const, key: "brand-test", startedAt: 1 };
    render(
      renderChatWorkingIndicator(part, { mascot: "claw", workingIndicator: "dots" }),
      container,
    );
    expect(container.querySelectorAll(".chat-reading-indicator--neutral > span")).toHaveLength(3);
    render(
      renderChatWorkingIndicator(part, { mascot: "none", workingIndicator: "claw" }),
      container,
    );
    expect(container.querySelector(".chat-reading-indicator svg")).not.toBeNull();
    render(renderChatWorkingIndicator(part, { workingIndicator: "brand" }), container);
    expect(container.querySelector(".chat-reading-indicator--brand")).not.toBeNull();
    render(
      renderChatWorkingIndicator(part, { workingIndicator: "none", workingPhrases: [] }),
      container,
    );
    expect(container.querySelector(".chat-reading-indicator")).toBeNull();
    expect(
      container
        .querySelector(".chat-working-indicator__status > span")
        ?.classList.contains("sr-only"),
    ).toBe(false);
    expect(container.textContent).toContain("Working");
  });

  it("renders neutral dots without claw surprises and forwards authored phrases", () => {
    const container = document.createElement("div");
    const workingPhrases = ["Building"];
    render(
      renderChatWorkingIndicator(
        { kind: "reading-indicator", key: findRenderKey(true), startedAt: 1 },
        { mascot: "none", workingPhrases },
      ),
      container,
    );
    const bubble = container.querySelector(".chat-reading-indicator--neutral");
    expect(bubble?.querySelectorAll("span")).toHaveLength(3);
    expect(bubble?.querySelector("svg")).toBeNull();
    expect(
      [...bubble!.classList].filter((name) => name.startsWith("chat-reading-indicator--")),
    ).toEqual(["chat-reading-indicator--neutral"]);
    expect(container.querySelector("openclaw-working-phrase")).toHaveProperty(
      "phrases",
      workingPhrases,
    );
  });
  // The render path seeds with the module's per-page-load salt, so probe that
  // same default salt for keys that do (and do not) surprise this session.
  function findRenderKey(wantSurprise: boolean): string {
    for (let index = 0; index < 10_000; index++) {
      const key = `probe:${index}`;
      if (Boolean(selectWorkingClawSurprise(key)) === wantSurprise) {
        return key;
      }
    }
    throw new Error(`no render key with surprise=${String(wantSurprise)}`);
  }

  function surpriseClassesFor(key: string, waitingApproval: boolean): string[] {
    const container = document.createElement("div");
    render(
      renderChatWorkingIndicator(
        { kind: "reading-indicator", key, startedAt: 1 },
        { waitingApproval },
      ),
      container,
    );
    const bubble = container.querySelector(".chat-reading-indicator");
    expect(bubble).not.toBeNull();
    return [...(bubble?.classList ?? [])].filter((name) =>
      name.startsWith("chat-reading-indicator--"),
    );
  }

  it("keeps approval waits on the default claw even for surprising keys", () => {
    expect(surpriseClassesFor(findRenderKey(true), true)).toEqual([]);
  });
});
