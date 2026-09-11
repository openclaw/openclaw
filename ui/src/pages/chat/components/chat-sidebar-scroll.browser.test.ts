import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { LitElement } from "lit";
import { describe, expect, it } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import {
  resetTaskDetail,
  retryTaskTranscript,
  type TaskDetailHost,
} from "./chat-task-detail-state.ts";
import { renderTaskDetailPanel } from "./chat-task-detail.ts";
import "./chat-sidebar.ts";

const browserMode = "__vitest_browser__" in globalThis;

class TaskActivityFixture extends LitElement {
  readonly task: TaskSummary = {
    id: "task-resize",
    taskId: "task-resize",
    agentId: "main",
    runtime: "subagent",
    status: "running",
    title: "Inspect the renderer",
    hasTranscript: true,
    progressSummary: "Checking the layout.",
  };
  messages: unknown[] = [
    {
      role: "user",
      messageId: "prompt",
      content:
        "Inspect the available tools and report their input schemas, including required parameters and optional fields, so the review can confirm that the next step uses the correct tool contract.",
    },
    {
      role: "assistant",
      messageId: "command",
      content: [
        {
          type: "toolCall",
          id: "schema-call",
          name: "exec",
          arguments: { command: `pnpm tsgo --project ${"x".repeat(510)}.json` },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "schema-call",
      content: [{ type: "text", text: "Schemas ready." }],
    },
    ...Array.from({ length: 24 }, (_, index) => ({
      role: "assistant",
      messageId: `activity-${index}`,
      content: `Activity ${index}: inspected the rendering boundary and its task history contract.`,
    })),
  ];
  readonly host: TaskDetailHost = {
    sessionKey: "agent:main:main",
    connected: true,
    hello: null,
    requestUpdate: () => this.requestUpdate(),
    client: createTestGatewayClient((_method, params) =>
      asNullableRecord(params)?.cursor
        ? {
            messages: Array.from({ length: 12 }, (_, index) => ({
              role: "assistant",
              messageId: `earlier-${index}`,
              content: `Earlier ${index}: planning the activity monitor.`,
            })),
          }
        : { messages: this.messages, nextCursor: "earlier-page" },
    ),
  };
  private readonly backgroundTasks: BackgroundTasksProps = {
    sessionKey: "agent:main:main",
    statusRowId: "task-status-resize",
    collapsed: false,
    narrowLayout: false,
    connected: true,
    canCancel: false,
    loading: false,
    error: null,
    tasks: [this.task],
    activeCount: 1,
    subagentActivity: { rows: [], overflowWorking: 0, taskIds: new Set(), nextExpiryAt: null },
    taskDetails: new Map([[this.task.id, { ...this.task, prompt: "Inspect the renderer." }]]),
    taskDetailErrors: new Map(),
    taskDetailLoadingIds: new Set(),
    cancellingTaskIds: new Set(),
    finishedCollapsed: false,
    onToggleCollapsed: () => {},
    onToggleFinished: () => {},
    onRefresh: () => {},
    onCancel: () => {},
  };

  appendActivity() {
    this.messages = [
      ...this.messages,
      {
        role: "assistant",
        messageId: `appended-${this.messages.length}`,
        content: `New activity ${this.messages.length}: verified the next rendering contract.`,
      },
    ];
    retryTaskTranscript(this.host);
  }

  override disconnectedCallback() {
    resetTaskDetail(this.host);
    super.disconnectedCallback();
  }

  protected override createRenderRoot() {
    return this;
  }

  protected override render() {
    return renderTaskDetailPanel({
      backgroundTasks: this.backgroundTasks,
      host: this.host,
      task: this.task,
    });
  }
}

customElements.define("test-sidebar-task-activity", TaskActivityFixture);

function mountTaskActivity(dir = "ltr") {
  const container = document.body.appendChild(document.createElement("div"));
  container.className = "side-panel__panel";
  container.dir = dir;
  container.style.cssText = "width:300px;height:600px;";
  const panel = new TaskActivityFixture();
  panel.style.cssText = "display:flex;min-height:0;width:100%;";
  container.append(panel);
  return { container, panel };
}

async function renderedActivity(panel: TaskActivityFixture) {
  await expect.poll(() => panel.querySelector(".chat-task-feed__entry")).not.toBeNull();
  await panel.updateComplete;
  await new Promise(requestAnimationFrame);
  return panel.querySelector<HTMLElement>(".chat-task-detail__content")!;
}

type DetailPanel = HTMLElement & {
  content: SidebarContent;
  updateComplete: Promise<unknown>;
};

// The detail panel only bounds itself through its host: `.side-panel__panel`
// (chat-sidebar-region.runtime.ts) is what grants the panel `min-height: 0`, so
// mounting it under any other class makes the sidebar grow instead of scroll.
function mountDetailPanel(content: SidebarContent): {
  panel: DetailPanel;
  release: () => void;
} {
  const container = document.createElement("div");
  container.className = "side-panel__panel";
  container.style.cssText = "display:flex;width:480px;height:320px;";

  const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
  panel.className = "chat-sidebar";
  panel.content = content;
  container.append(panel);
  document.body.append(container);

  return { panel, release: () => container.remove() };
}

describe.runIf(browserMode)("chat sidebar layout", () => {
  it.each(["ltr", "rtl"])(
    "keeps the history boundary above full-width task activity in %s",
    async (dir) => {
      const { container, panel } = mountTaskActivity(dir);
      try {
        const content = await renderedActivity(panel);
        const feed = panel.querySelector<HTMLElement>(".chat-task-feed")!;
        const history = panel.querySelector<HTMLElement>(".chat-history-boundary")!;
        const tool = panel.querySelector<HTMLElement>(".chat-task-feed__tool-group")!;
        for (const width of [300, 400, 600, 700]) {
          container.style.width = `${width}px`;
          await new Promise(requestAnimationFrame);
          const historyRect = history.getBoundingClientRect();
          const feedRect = feed.getBoundingClientRect();
          expect(historyRect.bottom).toBeLessThanOrEqual(feedRect.top);
          expect(Math.abs(historyRect.width - feedRect.width)).toBeLessThanOrEqual(1);
          expect(feedRect.width).toBeGreaterThan(width - 70);
          expect(tool.getBoundingClientRect().right).toBeLessThanOrEqual(
            content.getBoundingClientRect().right,
          );
          expect(tool.getBoundingClientRect().left).toBeGreaterThanOrEqual(
            content.getBoundingClientRect().left,
          );
          expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth);
        }
      } finally {
        container.remove();
      }
    },
  );

  it("pins first render and near-bottom appends while preserving an upward reader and prepended history", async () => {
    const { container, panel } = mountTaskActivity();
    try {
      const content = await renderedActivity(panel);
      const bottomGap = () => content.scrollHeight - content.clientHeight - content.scrollTop;
      await expect.poll(bottomGap).toBeLessThanOrEqual(1);
      expect(content.scrollHeight).toBeGreaterThan(content.clientHeight);

      content.scrollTop -= 20;
      content.dispatchEvent(new Event("scroll"));
      const initialEntries = panel.querySelectorAll(".chat-task-feed__entry").length;
      panel.appendActivity();
      await expect
        .poll(() => panel.querySelectorAll(".chat-task-feed__entry").length)
        .toBe(initialEntries + 1);
      await expect.poll(bottomGap).toBeLessThanOrEqual(1);

      content.scrollTop = 180;
      content.dispatchEvent(new Event("scroll"));
      const readingTop = content.scrollTop;
      panel.appendActivity();
      await expect
        .poll(() => panel.querySelectorAll(".chat-task-feed__entry").length)
        .toBe(initialEntries + 2);
      await new Promise(requestAnimationFrame);
      expect(content.scrollTop).toBe(readingTop);

      const anchor = [...panel.querySelectorAll<HTMLElement>(".chat-task-feed__entry")].find(
        (entry) => entry.textContent?.includes("Activity 0:"),
      )!;
      const beforeTop = anchor.getBoundingClientRect().top;
      panel.querySelector<HTMLButtonElement>(".chat-history-boundary__action")!.click();
      await expect.poll(() => panel.textContent?.includes("Earlier 0:")).toBe(true);
      await panel.updateComplete;
      // A second render before the frame must keep the pending offset correction.
      panel.requestUpdate();
      await panel.updateComplete;
      await new Promise(requestAnimationFrame);
      const retainedAnchor = [
        ...panel.querySelectorAll<HTMLElement>(".chat-task-feed__entry"),
      ].find((entry) => entry.textContent?.includes("Activity 0:"))!;
      expect(Math.abs(retainedAnchor.getBoundingClientRect().top - beforeTop)).toBeLessThanOrEqual(
        1,
      );
    } finally {
      container.remove();
    }
  });

  it("keeps long markdown scrollable inside a bounded sidebar", async () => {
    const { panel, release } = mountDetailPanel({
      kind: "markdown",
      content: Array.from(
        { length: 40 },
        (_, index) => `## Section ${index + 1}\n\nLong preview content for scrolling.`,
      ).join("\n\n"),
    });

    try {
      await panel.updateComplete;
      const content = panel.querySelector<HTMLElement>(".sidebar-content");
      expect(content).not.toBeNull();
      expect(content!.clientHeight).toBeLessThan(content!.scrollHeight);

      content!.scrollTop = content!.scrollHeight;
      await new Promise(requestAnimationFrame);
      expect(content!.scrollTop).toBeGreaterThan(0);
    } finally {
      release();
    }
  });

  it("keeps long files scrollable inside CodeMirror", async () => {
    const { panel, release } = mountDetailPanel({
      kind: "file",
      path: "src/long-example.ts",
      name: "long-example.ts",
      language: "typescript",
      content: Array.from(
        { length: 200 },
        (_, index) => `export const value${index + 1} = ${index + 1};`,
      ).join("\n"),
    });

    try {
      await panel.updateComplete;
      await expect
        .poll(() => panel.querySelector<HTMLElement>(".cm-scroller"), { timeout: 5_000 })
        .not.toBeNull();
      const scroller = panel.querySelector<HTMLElement>(".cm-scroller");
      expect(scroller).not.toBeNull();
      expect(scroller!.clientHeight).toBeLessThan(scroller!.scrollHeight);

      scroller!.scrollTop = scroller!.scrollHeight;
      await new Promise(requestAnimationFrame);
      expect(scroller!.scrollTop).toBeGreaterThan(0);
    } finally {
      release();
    }
  });
});
