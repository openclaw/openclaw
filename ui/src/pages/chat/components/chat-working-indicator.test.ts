import { createComponent, createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { selectWorkingClawSurprise } from "./chat-working-indicator-surprise.ts";
import { ChatWorkingIndicator } from "./chat-working-indicator.tsx";

const bubbleSelector = ".chat-bubble.chat-reading-indicator";

type Options = Parameters<typeof ChatWorkingIndicator>[0]["options"];

function indicator(key: string, initial: Options = {}) {
  const [options, setOptions] = createSignal(initial);
  const view = mountSolid(() =>
    createComponent(ChatWorkingIndicator, {
      part: { kind: "reading-indicator", key, startedAt: 1 },
      get options() {
        return options();
      },
    }),
  );
  flush();
  return {
    ...view,
    find: (selector: string) => view.container.querySelector(selector),
    draw: (next: Options) => {
      setOptions(next);
      flush();
    },
  };
}

function surpriseKey(): string {
  for (let index = 0; index < 10_000; index++) {
    const key = `probe:${index}`;
    if (selectWorkingClawSurprise(key)) {
      return key;
    }
  }
  throw new Error("no surprising render key");
}

it("pops in for new work but continues a claw that another one just handed off", () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
  const isContinued = (view: ReturnType<typeof indicator>) =>
    view.find(".chat-working-indicator")?.classList.contains("chat-working-indicator--continued");
  const preview = indicator("handoff");
  expect(isContinued(preview)).toBe(false);
  preview.unmount();
  now.mockReturnValue(10_200);
  expect(isContinued(indicator("handoff"))).toBe(true);
});

it("keeps the parent's own glyph beside child counts and restores it after a wait", () => {
  const { container, draw, find } = indicator("parent-work", {
    outputTokens: 4_100,
    runningSubagents: 2,
  });
  expect(find(bubbleSelector)).not.toBeNull();
  expect(container.textContent).toContain("2 subagents running");
  expect(container.textContent).toContain("4.1k output tokens");
  expect(find(".chat-subagent-activity")).toBeNull();
  draw({
    outputTokens: 4_100,
    runningSubagents: 2,
    waitingSubagents: { startedAt: 1, runningCount: 2 },
  });
  expect(find(bubbleSelector)).toBeNull();
  expect(find("openclaw-working-phrase")).toBeNull();
  expect(container.textContent).toContain("2 subagents running");
  draw({ outputTokens: 4_100, runningSubagents: 1 });
  expect(find(bubbleSelector)).not.toBeNull();
  expect(container.textContent).toContain("1 subagent running");
});

it("selects the working glyph independently of the mascot and keeps text when hidden", () => {
  const { container, draw, find } = indicator("brand-test", {
    mascot: "claw",
    workingIndicator: "dots",
  });
  expect(container.querySelectorAll(".chat-reading-indicator--neutral > span")).toHaveLength(3);
  draw({ mascot: "none", workingIndicator: "claw" });
  expect(find(".chat-reading-indicator svg")).not.toBeNull();
  draw({ workingIndicator: "brand" });
  expect(find(".chat-reading-indicator--brand")).not.toBeNull();
  draw({ workingIndicator: "none", workingPhrases: [] });
  expect(find(bubbleSelector)).toBeNull();
  expect(find(".chat-working-indicator__status > span")?.classList.contains("sr-only")).toBe(false);
  expect(container.textContent).toContain("Working");
});

it.each<[Options, string[]]>([
  [{ mascot: "none", workingPhrases: ["Building"] }, ["chat-reading-indicator--neutral"]],
  [{ waitingApproval: true }, []],
])("suppresses surprising claws for %j", (options, expectedClasses) => {
  const { find } = indicator(surpriseKey(), options);
  const bubble = find(bubbleSelector);
  expect(
    [...bubble!.classList].filter((name) => name.startsWith("chat-reading-indicator--")),
  ).toEqual(expectedClasses);
  if (options.workingPhrases) {
    expect(bubble?.querySelectorAll("span")).toHaveLength(3);
    expect(bubble?.querySelector("svg")).toBeNull();
    expect(find("openclaw-working-phrase")).toHaveProperty("phrases", options.workingPhrases);
  }
});

it("retains an open activity disclosure and its animation when usage updates", () => {
  const totals = { bubbleMode: true, outputTokens: 12 };
  const { container, draw, find } = indicator("run", totals);
  const details = Object.assign(container.querySelector("details")!, { open: true });
  const glyph = find("summary .chat-bubble-dots")!;
  draw({ ...totals, outputTokens: 27 });
  expect(find("details")).toBe(details);
  expect(details.open).toBe(true);
  expect(find("summary .chat-bubble-dots")).toBe(glyph);
  expect(container.textContent).toContain("27 output tokens");
});
