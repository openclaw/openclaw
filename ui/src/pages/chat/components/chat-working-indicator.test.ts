import { createComponent, createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
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

it("promotes child activity above supporting totals and restores the standalone glyph", async () => {
  const { draw, find } = indicator("task-first", { outputTokens: 4_100 });
  expect(find(bubbleSelector)).not.toBeNull();
  const session: GatewaySessionRow = { key: "agent:a:subagent:b", kind: "direct", updatedAt: 1 };
  draw({
    outputTokens: 4_100,
    subagentActivity: {
      rows: [{ key: session.key, label: "Task", status: "running", listed: true, session }],
    },
  });
  await vi.dynamicImportSettled();
  flush();
  const task = find(".chat-subagent-activity");
  const status = find(".chat-working-indicator");
  expect(status?.classList.contains("chat-working-indicator--supporting")).toBe(true);
  expect(task!.compareDocumentPosition(status!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(find(bubbleSelector)).toBeNull();
  expect(status?.textContent).toContain("4.1k output tokens");
  draw({ outputTokens: 4_100 });
  expect(find(".chat-subagent-activity")).toBeNull();
  expect(find(".chat-working-indicator--supporting")).toBeNull();
  expect(find(bubbleSelector)).not.toBeNull();
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
  const glyph = find(bubbleSelector)!;
  draw({ ...totals, outputTokens: 27 });
  expect(find("details")).toBe(details);
  expect(details.open).toBe(true);
  expect(find(bubbleSelector)).toBe(glyph);
  expect(container.textContent).toContain("27 output tokens");
});
