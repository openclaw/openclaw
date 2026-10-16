import { createComponent, createSignal, flush } from "solid-js";
import { describe, expect, it, onTestFinished } from "vitest";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { selectWorkingClawSurprise } from "./chat-working-indicator-surprise.ts";
import { ChatWorkingIndicator } from "./chat-working-indicator.tsx";

type ChatWorkingIndicatorOptions = Parameters<typeof ChatWorkingIndicator>[0]["options"];

function mountIndicator(
  part: Extract<ChatItem, { kind: "reading-indicator" }>,
  initial: ChatWorkingIndicatorOptions,
) {
  const [options, setOptions] = createSignal(initial);
  const view = mountSolid(() =>
    createComponent(ChatWorkingIndicator, {
      part,
      get options() {
        return options();
      },
    }),
  );
  onTestFinished(view.unmount);
  flush();
  return {
    container: view.container,
    draw: (next: ChatWorkingIndicatorOptions) => {
      setOptions(next);
      flush();
    },
  };
}

function findRenderKey(wantSurprise: boolean): string {
  for (let index = 0; index < 10_000; index++) {
    const key = `probe:${index}`;
    if (Boolean(selectWorkingClawSurprise(key)) === wantSurprise) {
      return key;
    }
  }
  throw new Error(`no render key with surprise=${String(wantSurprise)}`);
}

describe("ChatWorkingIndicator", () => {
  it("promotes child activity above supporting totals and restores the standalone glyph", () => {
    const { container, draw } = mountIndicator(
      { kind: "reading-indicator", key: "task-first", startedAt: 1 },
      { outputTokens: 4_100 },
    );
    expect(container.querySelector(".chat-reading-indicator")).not.toBeNull();
    const activity = document.createElement("div");
    activity.className = "task-first-probe";
    activity.textContent = "Backend implementation";
    draw({ outputTokens: 4_100, subagentActivity: activity });
    const task = container.querySelector(".task-first-probe");
    const status = container.querySelector(".chat-working-indicator");
    expect(task).not.toBeNull();
    expect(status?.classList.contains("chat-working-indicator--supporting")).toBe(true);
    expect(task!.compareDocumentPosition(status!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector(".chat-reading-indicator")).toBeNull();
    expect(status?.textContent).toContain("4.1k output tokens");
    draw({ outputTokens: 4_100 });
    expect(container.querySelector(".task-first-probe")).toBeNull();
    expect(container.querySelector(".chat-working-indicator--supporting")).toBeNull();
    expect(container.querySelector(".chat-reading-indicator")).not.toBeNull();
  });

  it("selects the working glyph independently of the mascot and keeps text when hidden", () => {
    const { container, draw } = mountIndicator(
      { kind: "reading-indicator", key: "brand-test", startedAt: 1 },
      { mascot: "claw", workingIndicator: "dots" },
    );
    expect(container.querySelectorAll(".chat-reading-indicator--neutral > span")).toHaveLength(3);
    draw({ mascot: "none", workingIndicator: "claw" });
    expect(container.querySelector(".chat-reading-indicator svg")).not.toBeNull();
    draw({ workingIndicator: "brand" });
    expect(container.querySelector(".chat-reading-indicator--brand")).not.toBeNull();
    draw({ workingIndicator: "none", workingPhrases: [] });
    expect(container.querySelector(".chat-reading-indicator")).toBeNull();
    expect(
      container
        .querySelector(".chat-working-indicator__status > span")
        ?.classList.contains("sr-only"),
    ).toBe(false);
    expect(container.textContent).toContain("Working");
  });

  it("renders neutral dots without claw surprises and forwards authored phrases", () => {
    const workingPhrases = ["Building"];
    const { container } = mountIndicator(
      { kind: "reading-indicator", key: findRenderKey(true), startedAt: 1 },
      { mascot: "none", workingPhrases },
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

  it("keeps approval waits on the default claw even for surprising keys", () => {
    const { container } = mountIndicator(
      { kind: "reading-indicator", key: findRenderKey(true), startedAt: 1 },
      { waitingApproval: true },
    );
    const bubble = container.querySelector(".chat-reading-indicator");
    expect(bubble).not.toBeNull();
    expect(
      [...bubble!.classList].filter((name) => name.startsWith("chat-reading-indicator--")),
    ).toEqual([]);
  });

  it("retains an open activity disclosure and its animation when usage updates", () => {
    const { container, draw } = mountIndicator(
      { kind: "reading-indicator", key: "steady-run", startedAt: 1 },
      { bubbleMode: true, outputTokens: 12 },
    );
    const details = container.querySelector("details")!;
    details.open = true;
    const glyph = container.querySelector(".chat-reading-indicator")!;
    draw({ bubbleMode: true, outputTokens: 27 });
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(container.querySelector(".chat-reading-indicator")).toBe(glyph);
    expect(container.textContent).toContain("27 output tokens");
  });
});
