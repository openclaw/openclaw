import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  createAssistantMessage,
  createMessageEntry,
  createToolCall,
  createToolGroup,
  createToolResultBlock,
} from "./chat-message.test-support.ts";
import { renderActivityGroup, renderWorkGroupSummary } from "./chat-message.ts";

describe("tool group disclosures", () => {
  it("keeps full command titles accessible without repeating the work and activity labels", () => {
    const container = document.createElement("div");
    const command = `pnpm docs:list | rg 'Take photo|takePhoto|photoInput|accept=.?image/|Photo'`;
    const fullTitle = `Exec run ${command}`;
    const group = createToolGroup("exec-group", [
      createMessageEntry(
        "exec-message",
        createAssistantMessage(
          [0, 1, 2].flatMap((index) => [
            createToolCall(`exec-${index}`, "exec", { command: index === 2 ? command : "pwd" }),
            createToolResultBlock(`exec-${index}`, "exec", "Done", { isError: false }),
          ]),
          {
            activity: [0, 1, 2].map((index) => ({
              itemId: `exec-${index}`,
              toolCallId: `exec-${index}`,
              kind: "tool",
              name: "exec",
              phase: "end",
              status: "completed",
              title: index === 2 ? fullTitle : "Exec",
            })),
          },
        ),
      ),
    ]);
    const onToggle = vi.fn();
    const work = { key: "work-exec", durationMs: 22_000, groups: [group] };
    render(renderWorkGroupSummary(work, { expanded: false, onToggle }), container);
    expect(container.querySelector(".chat-activity-group__label")?.textContent).toBe(
      "Worked for 22s",
    );
    expect(container.querySelector("button")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Worked for 22s",
    );
    const summary = container.querySelector("button")!;
    expect(summary.getAttribute("aria-description")).toContain(fullTitle);
    expect(summary.getAttribute("aria-description")).toContain("22s");
    summary.click();
    expect(onToggle).toHaveBeenCalledOnce();

    render(
      html`${renderWorkGroupSummary(work, { expanded: true, onToggle })}
      ${renderActivityGroup([group], { showReasoning: false, showToolCalls: true })}`,
      container,
    );
    const labels = [...container.querySelectorAll(".chat-activity-group__label")];
    expect(labels.map((label) => label.textContent)).toEqual(["Worked for 22s", "Exec ×3"]);
    expect(labels[1]?.getAttribute("title")).toBe(`Exec ×2, ${fullTitle}`);
    expect(
      container.querySelectorAll('[aria-expanded="false"]')[0]?.getAttribute("aria-description"),
    ).toBe(`Exec ×2, ${fullTitle}`);
  });
});
