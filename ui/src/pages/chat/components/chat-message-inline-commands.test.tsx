/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { projectAgentToolActivity } from "../../../../../src/infra/agent-activity-events.js";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { inlineCommandPresentation } from "../chat-inline-command-presentation.ts";
import { createActivityGroupHarness } from "./chat-message-native.test-support.tsx";
import {
  createToolGroup,
  prepareHistoryGroups,
  type TestMessageEntry,
} from "./chat-message.test-support.ts";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";

function operation(key: string, name: string, args: unknown, parentToolCallId?: string) {
  return {
    key,
    message: {
      role: "custom",
      runId: "inline-run",
      timestamp: 1000,
      content: [
        {
          type: "toolCall",
          id: key,
          name,
          arguments: args,
          runId: "inline-run",
          ...(parentToolCallId ? { parentToolCallId } : {}),
        },
        { type: "toolResult", toolCallId: key, toolName: name, content: "Checked" },
      ],
    },
  };
}

function fixture(entries: TestMessageEntry[]): MessageGroup[] {
  return prepareHistoryGroups([createToolGroup("activity", entries)]);
}

function mountActivity() {
  const container = document.body.appendChild(document.createElement("div"));
  const view = createActivityGroupHarness(container);
  onTestFinished(() => {
    view.unmount();
    container.remove();
  });
  return { container, view };
}

it("exposes commands and exploration while preserving native edit groups and disclosure identities", async () => {
  const { container, view } = mountActivity();
  const groups = fixture([
    operation("first", "exec", { command: "printf first" }),
    operation("read", "read", { path: "source.ts" }),
    operation("search", "grep", { pattern: "TODO", path: "src" }),
    operation("edit-one", "edit", { path: "one.ts", oldText: "a", newText: "b" }),
    operation("edit-two", "edit", { path: "two.ts", oldText: "a", newText: "b" }),
    operation("last", "exec", { command: "printf last" }),
  ]);
  const toggle = vi.fn();
  const base = { showReasoning: false, onToggleToolExpanded: toggle };
  view.render(groups, base);
  await settleToolBridges(container);
  expect(container.querySelectorAll(".chat-activity-group__summary")).toHaveLength(1);
  expect(container.querySelector(".chat-tool-row")).toBeNull();

  view.render(groups, { ...base, inlineCommands: await inlineCommandPresentation() });
  await settleToolBridges(container);
  expect(container.querySelectorAll(".chat-activity-group__summary")).toHaveLength(1);
  const rows = [...container.querySelectorAll<HTMLButtonElement>(".chat-tool-row")];
  expect(rows).toHaveLength(4);
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("printf first"),
    expect.stringContaining("source.ts"),
    expect.stringContaining("TODO"),
    expect.stringContaining("printf last"),
  ]);
  expect(container.textContent).not.toContain("one.ts");
  rows[3]!.click();
  expect(toggle).toHaveBeenCalledWith("last:toolcard:0", false);

  view.render(groups, {
    ...base,
    inlineCommands: await inlineCommandPresentation(),
    isToolMessageExpanded: () => true,
  });
  await settleToolBridges(container);
  expect(container.textContent).toContain("one.ts");
  expect(container.textContent).toContain("two.ts");
  expect(container.querySelector(".chat-tool-row")).toBe(rows[0]);
});

it("keeps a command child under its parent across an intervening inline command", async () => {
  const { container, view } = mountActivity();
  const groups = fixture([
    operation("parent", "tool_search", { query: "Inspect source" }),
    operation("unrelated", "exec", { command: "printf unrelated" }),
    operation("child", "exec", { command: "printf nested" }, "parent"),
  ]);
  view.render(groups, {
    showReasoning: false,
    inlineCommands: await inlineCommandPresentation(),
    isToolMessageExpanded: () => true,
    isToolExpanded: (id) => id === "parent:toolcard:0",
  });
  await settleToolBridges(container);
  const nested = container.querySelector(".chat-tool-children");
  expect(nested?.textContent).toContain("printf nested");
  expect(nested?.textContent).not.toContain("printf unrelated");
  expect(
    [...container.querySelectorAll(".chat-tool-row")].filter((row) =>
      row.textContent?.includes("printf nested"),
    ),
  ).toHaveLength(1);
  const inline = container.querySelector(".chat-activity-group--inline");
  expect(inline?.textContent).toContain("printf unrelated");
  expect(inline?.textContent).not.toContain("printf nested");
});

it.each([false, true])(
  "retains the active noncommand purpose and bubble marker across inline segments (bubbles=%s)",
  async (bubbleMode) => {
    const { container, view } = mountActivity();
    const args = { query: "Release notes" };
    const pending = operation("active-other", "lookup_record", args);
    const groups = [
      createToolGroup("activity", [
        operation("completed-other", "lookup_record", { query: "Earlier record" }),
        operation("completed-command", "exec", { command: "printf checked" }),
        {
          ...pending,
          message: {
            ...pending.message,
            content: [pending.message.content[0]],
            activity: [
              projectAgentToolActivity({
                toolCallId: "active-other",
                name: "lookup_record",
                args,
                phase: "start",
              }),
            ],
          },
        },
      ]),
    ];
    const options = {
      showReasoning: false,
      runActive: true,
      activityRunId: "inline-run",
      activityGroupKey: "activity",
      bubbleMode,
      bubbleActivityGroupKey: "activity",
    };
    const label = () =>
      [
        ...container.querySelectorAll(".chat-activity-group__summary .chat-activity-group__label"),
      ].at(-1)?.textContent;
    view.render(groups, options);
    await settleToolBridges(container);
    const purpose = label();
    expect(purpose).toContain("Release notes");
    view.render(groups, { ...options, inlineCommands: await inlineCommandPresentation() });
    await settleToolBridges(container);
    expect(label()).toBe(purpose);
    const working = container.querySelectorAll(
      ".chat-activity-group--working .chat-bubble-dots--working",
    );
    expect(working).toHaveLength(bubbleMode ? 1 : 0);
    if (bubbleMode) {
      expect(working[0]?.closest(".chat-activity-group")?.textContent).toContain("Release notes");
    }
  },
);

it("retains separate text and media from an entry whose tool card moved under its parent", async () => {
  const { container, view } = mountActivity();
  const child = operation("child-media", "exec", { command: "printf nested-media" }, "parent");
  const groups = fixture([
    operation("parent", "tool_search", { query: "Inspect source" }),
    operation("unrelated", "exec", { command: "printf unrelated" }),
    {
      ...child,
      message: {
        ...child.message,
        content: [
          ...child.message.content,
          { type: "text", text: "Supplemental child note" },
          {
            type: "image",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
            mimeType: "image/png",
            alt: "Nested result image",
          },
        ],
      },
    },
  ]);
  const options = {
    showReasoning: false,
    isToolMessageExpanded: () => true,
    isToolExpanded: (id: string) => id === "parent:toolcard:0",
  };
  for (const inlineCommands of [undefined, await inlineCommandPresentation()]) {
    view.render(groups, { ...options, inlineCommands });
    await settleToolBridges(container);
    expect(container.textContent).toContain("Supplemental child note");
    expect(container.querySelectorAll('img[alt="Nested result image"]')).toHaveLength(1);
    expect(
      [...container.querySelectorAll(".chat-tool-row")].filter((row) =>
        row.textContent?.includes("printf nested-media"),
      ),
    ).toHaveLength(1);
    expect(container.querySelector(".chat-tool-children")?.textContent).toContain(
      "printf nested-media",
    );
  }
});

it("keeps native edit cards and original indexes in a mixed command envelope", async () => {
  const { container, view } = mountActivity();
  const command = operation("command", "exec", { command: "printf mixed" });
  const edit = operation("patch", "edit", { path: "mixed.ts", oldText: "a", newText: "b" });
  const groups = fixture([
    {
      key: "mixed",
      message: {
        role: "custom",
        runId: "inline-run",
        timestamp: 1000,
        content: [...command.message.content, ...edit.message.content],
      },
    },
  ]);
  const toggle = vi.fn();
  view.render(groups, {
    showReasoning: false,
    inlineCommands: await inlineCommandPresentation(),
    onToggleToolExpanded: toggle,
  });
  await settleToolBridges(container);
  expect(container.querySelector(".chat-activity-group__summary")).toBeNull();
  expect(container.querySelectorAll(".chat-tool-row")).toHaveLength(2);
  const editToggle = container.querySelector<HTMLButtonElement>(
    '.chat-tool-row__toggle[aria-label*="mixed.ts"]',
  );
  const editRow = [...container.querySelectorAll<HTMLButtonElement>(".chat-tool-row")].find((row) =>
    row.textContent?.includes("mixed.ts"),
  );
  (editToggle ?? editRow)!.click();
  expect(toggle).toHaveBeenCalledWith("mixed:toolcard:1", false);
});
