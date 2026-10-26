/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { projectAgentActivityItem } from "../../../../../src/agents/agent-activity-presentation.js";
import { projectAgentToolActivity } from "../../../../../src/infra/agent-activity-events.js";
import {
  WIDGET_PROMPT_EVENT,
  type WidgetPromptEventDetail,
} from "../../../components/mcp-app-security.ts";
import { t } from "../../../i18n/index.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type { DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import {
  resolveCollapsedToolArgumentPreview,
  extractToolCardsCached,
} from "../../../lib/chat/tool-cards.ts";
import { mountSolid as mountComponent } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { attachHistoryActivity } from "../chat-history-request.ts";
import { agentEvent, createHost } from "../tool-stream.test-helpers.ts";
import { handleAgentEvent } from "../tool-stream.ts";
import { DiffBlock } from "./chat-diff-render.solid.tsx";
import { createActivityGroupHarness } from "./chat-message-native.test-support.tsx";
import { createMessageEntry, createToolGroup } from "./chat-message.test-support.ts";
import { mountCard, mountPreview } from "./chat-tool-cards.test-support.tsx";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";

const canvas = { kind: "canvas", surface: "assistant_message", render: "url" } as const;

const query = (root: ParentNode | null | undefined, selector: string) =>
  root?.querySelector<HTMLElement>(selector) ?? null;
const textOf = (root: ParentNode, selector: string) => root.querySelector(selector)?.textContent;
const change = (path: string, diff: string, type = "update") => ({ path, kind: { type }, diff });
const patchCard = (args: ToolCard["args"], extra: Partial<ToolCard> = {}): ToolCard => ({
  id: "patch",
  name: "apply_patch",
  args,
  ...extra,
});
const canvasPreview = (viewId: string) => ({
  ...canvas,
  viewId,
  url: `/__openclaw__/canvas/documents/${viewId}/index.html`,
});
function mountTool(
  name: string,
  card: Partial<ToolCard>,
  options?: Parameters<typeof mountCard>[1],
  container?: Parameters<typeof mountCard>[2],
) {
  return mountCard({ id: name, name, ...card }, options, container);
}

it("routes MCP App previews through the dedicated double-iframe host", async () => {
  const container = document.createElement("div");
  const preview = { ...canvas, viewId: "cv_app", mcpApp: { viewId: "cv_app" } } as const;
  const options = { sessionKey: "agent:main:main" };
  mountPreview(preview, "chat_message", options, container);

  await vi.dynamicImportSettled();
  await waitForSolid(() => expect(query(container, "mcp-app-view")).not.toBeNull());
  const view = query(container, "mcp-app-view");
  expect(view?.getAttribute("src")).toBeNull();
  expect(view).toMatchObject({ sessionKey: "agent:main:main", viewId: "cv_app", height: 600 });
  await customElements.whenDefined("mcp-app-view");
  expect(view).toMatchObject({ sessionKey: "agent:main:main", viewId: "cv_app" });

  const toolContainer = document.createElement("div");
  mountPreview(preview, "chat_tool", options, toolContainer);
  expect(toolContainer.querySelector("mcp-app-view")).toBeNull();
});

it("switches a completed patch between mutually exclusive diff and raw bodies", async () => {
  const card = patchCard(
    {
      changes: [
        change("src/a.ts", "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old a\n+new a\n"),
        change("src/b.ts", "new b\n", "add"),
      ],
    },
    { id: "msg:patch:multi", outputText: "Applied patch" },
  );
  const container = await mountCard(card);

  const diff = query(container, ".chat-diff");
  expect(diff?.getAttribute("aria-label")).toBe("File changes");
  const fileRows = Array.from(diff?.querySelectorAll(".chat-diff__row--file") ?? []);
  expect(fileRows.map((row) => textOf(row, ".chat-diff__text"))).toEqual([
    "Update src/a.ts",
    "Add src/b.ts",
  ]);
  expect(fileRows.every((row) => row.querySelector(".chat-diff__gutter") !== null)).toBe(true);
  expect(query(diff, ".chat-diff__row--del .chat-diff__text")?.textContent).toBe("old a");
  expect(
    Array.from(diff?.querySelectorAll(".chat-diff__row--add .chat-diff__text") ?? []).map(
      (row) => row.textContent,
    ),
  ).toEqual(["new a", "new b"]);

  const tabGroup = query(container, ".chat-tool-card__modes");
  const tabList = query(tabGroup, '[role="tablist"]');
  await waitForSolid(() => expect(tabList?.getAttribute("aria-label")).toBe("Tool detail view"));
  const tabs = Array.from(tabGroup?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
  expect(tabs.map((tab) => [tab.textContent?.trim(), tab.getAttribute("aria-selected")])).toEqual([
    ["Diff", "true"],
    ["Raw", "false"],
  ]);
  const diffBody = query(container, '[id$="-diff-panel"]');
  const rawBody = query(container, '[id$="-raw-panel"]');
  const expectPanels = (raw: boolean) =>
    expect([diffBody?.hidden, rawBody?.hidden]).toEqual([raw, !raw]);
  expectPanels(false);
  expect(query(rawBody, "code")).toBeNull();

  tabs[1]?.click();
  await waitForSolid(() =>
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]),
  );
  expectPanels(true);
  expect(query(diffBody, ".chat-diff")).toBe(diff);
  expect(query(rawBody, "code")?.textContent).toBe("Applied patch");

  await mountCard(
    {
      ...card,
      args: { changes: [change("src/a.ts", "@@ -1 +1 @@\n-old\n+new\n")] },
      completed: true,
    },
    {},
    container,
  );
  await waitForSolid(() => {
    expect(query(container, ".chat-tool-card__modes")).toBe(tabGroup);
    expect(rawBody?.hidden).toBe(false);
    expect(tabList?.getAttribute("aria-label")).toBe("Tool detail view");
  });
  tabs[0]?.click();
  await waitForSolid(() => expectPanels(false));
  expect(query(rawBody, "code")?.textContent).toBe("Applied patch");
  expect(textOf(diffBody!, ".chat-diff__row--add .chat-diff__text")).toBe("new");
  container.remove();
});

it("scans unnumbered diff lines once while rendering every row", () => {
  let numberReads = 0;
  const lines: DiffLine[] = Array.from({ length: 256 }, (_, index) => ({
    kind: "ctx",
    text: `line ${index}`,
    get lineNo() {
      numberReads += 1;
      return undefined;
    },
  }));
  const view = mountComponent(DiffBlock, { lines });
  onTestFinished(view.dispose);
  expect(view.container.querySelectorAll(".chat-diff__row")).toHaveLength(lines.length);
  expect(view.container.querySelector(".chat-diff__gutter")).toBeNull();
  expect(numberReads).toBeLessThanOrEqual(lines.length * 2);
});

it.each([
  [true, "Patch context did not match", undefined],
  [
    false,
    "Skipped to process an incoming message.",
    { status: "skipped", deniedReason: "steering" },
  ],
] as const)("prefers rejected edit output (%s)", async (isError, outputText, details) => {
  const container = await mountTool("edit", {
    args: { path: "src/a.ts", oldText: "before", newText: "after" },
    outputText,
    details,
    completed: true,
    isError,
  });

  const rawTab = query(container, '[role="tab"][data-tab-value="raw"]');
  await waitForSolid(() => expect(rawTab?.getAttribute("aria-selected")).toBe("true"));
  const rawBody = query(container, '[id$="-raw-panel"]');
  expect(rawBody?.hidden).toBe(false);
  expect(query(rawBody, "code")?.textContent).toBe(outputText);
  expect(query(container, ".chat-diff")).toBeNull();
  container.remove();
});

it("labels a completed Codex file creation from its recorded operation", async () => {
  const onOpenWorkspaceFile = vi.fn();
  const onToggleExpanded = vi.fn();
  const container = await mountCard(
    patchCard(
      { changes: [change("src/new.ts", "export const created = true;\n", "add")] },
      { id: "msg:patch:add", completed: true },
    ),
    { expanded: false, onOpenWorkspaceFile, onToggleExpanded },
  );

  expect(textOf(container, ".chat-tool-row__verb")).toBe("Created");
  expect(textOf(container, ".chat-tool-row__file-link")?.trim()).toBe("new.ts");
  query(container, ".chat-tool-row__file-link")?.click();
  expect(onOpenWorkspaceFile).toHaveBeenCalledWith({ path: "src/new.ts" });
  expect(onToggleExpanded).not.toHaveBeenCalled();

  expect(query(container, ".chat-tool-row__toggle")?.getAttribute("aria-label")).toBe(
    "Created new.ts",
  );
  query(container, ".chat-tool-row__toggle")?.click();
  expect(onToggleExpanded).toHaveBeenCalledWith("msg:patch:add");
  expect(onOpenWorkspaceFile).toHaveBeenCalledOnce();
});

it.each([
  ["*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+added", "2 files"],
  ["*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-old\n+new", "old.ts → new.ts"],
  ["*** Delete File: src/gone.ts", "gone.ts"],
])("keeps patch summaries non-navigable: %s", async (body, target) => {
  const onOpenWorkspaceFile = vi.fn();
  const onToggleExpanded = vi.fn();
  const container = await mountCard(
    patchCard(
      { patch: `*** Begin Patch\n${body}\n*** End Patch` },
      { id: `msg:patch:${target}`, completed: true },
    ),
    { expanded: false, onOpenWorkspaceFile, onToggleExpanded },
  );

  expect(query(container, ".chat-tool-row--file")).toBeNull();
  expect(textOf(container, ".chat-tool-row__target")).toBe(target);
  query(container, ".chat-tool-msg-summary")?.click();
  expect(onToggleExpanded).toHaveBeenCalledOnce();
  expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
});

it("renders edit and write rows from their result outcome", async () => {
  const mutations = [
    [
      "edit",
      { path: "/repo/src/a.ts", oldText: "old", newText: "new" },
      { running: "Editing", succeeded: "Edited", neutral: "Edit" },
    ],
    [
      "write",
      { path: "/repo/src/b.ts", content: "new file\n" },
      { running: "Writing", succeeded: "Wrote", neutral: "Write" },
    ],
  ] as const;
  const states = [
    [
      { live: true, liveDiffStat: { added: 12, removed: 3 } },
      true,
      "running",
      "Attempted changes",
      true,
      false,
    ],
    [{ completed: true }, false, "succeeded", "File changes", true, false],
    [{ completed: true, isError: true }, false, "neutral", "Attempted changes", false, true],
    [{}, false, "neutral", "Attempted changes", false, false],
    [{ completed: true, outputText: "" }, false, "succeeded", "File changes", true, false],
  ] as const;
  for (const [name, args, verbs] of mutations) {
    for (const [card, runActive, verb, label, hasStat, failed] of states) {
      const container = await mountCard({ id: name, name, args, ...card }, { runActive });
      expect(textOf(container, ".chat-tool-row__verb")).toBe(verbs[verb]);
      expect(query(container, ".chat-diff")?.getAttribute("aria-label")).toBe(label);
      expect(query(container, ".chat-diffstat") !== null).toBe(hasStat);
      if (failed) {
        expect(textOf(container, ".chat-tool-card__outcome")).toBe("failed");
      }
      expect(query(container, ".chat-tool-msg-summary--error")).toBeNull();
    }
  }
});

it.each([false, true])("reports clipboard failure=%s when copying a patch", async (failed) => {
  const feedback = failed ? "Copy failed" : "Copied!";
  const writeText = failed
    ? vi.fn().mockRejectedValue(new DOMException("Clipboard access denied", "NotAllowedError"))
    : vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const container = document.body.appendChild(document.createElement("div"));
  const onOpenSidebar = vi.fn();
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  await mountCard(
    patchCard(
      {
        changes: [
          change(
            "src/patch.ts",
            "--- a/src/patch.ts\n+++ b/src/patch.ts\n@@ -1 +1 @@\n-old patch\n+new patch\n",
          ),
        ],
      },
      { id: "copy", completed: true },
    ),
    { onOpenSidebar },
    container,
  );
  const copyButton = query(container, '.chat-tool-card__actions button[aria-label="Copy"]');
  expect(copyButton).toBeInstanceOf(HTMLButtonElement);
  copyButton!.click();
  await vi.waitFor(() => expect(copyButton!.getAttribute("aria-label")).toBe(feedback));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("new patch"));
  const status = copyButton!.parentElement?.querySelector<HTMLElement>('[role="status"]');
  expect(status).toMatchObject({ textContent: feedback, hidden: false });
  const sidebarButton = query(
    container,
    `.chat-tool-card__actions button[aria-label="${t("chat.toolCards.openDetails")}"]`,
  );
  expect(sidebarButton).toBeInstanceOf(HTMLButtonElement);
  sidebarButton!.click();
  expect(onOpenSidebar).toHaveBeenCalledOnce();
});

it("keeps read ranges visible and opens the unmodified file path", async () => {
  const args = { path: "/repo/src/a.ts", offset: 40, limit: 20 };
  const onOpenWorkspaceFile = vi.fn();
  const container = await mountCard(
    { id: "msg:read:range", name: "read", args, inputText: JSON.stringify(args) },
    { onOpenWorkspaceFile },
  );

  const pathButton = query(container, '.chat-tool-card__detail-link[title="Open file"]');
  expect(pathButton).toBeInstanceOf(HTMLButtonElement);
  pathButton!.click();
  expect(onOpenWorkspaceFile).toHaveBeenCalledWith({ path: args.path });
  expect(textOf(container, ".chat-tool-row__verb")).toBe("Read");
  const rows = Array.from(container.querySelectorAll(".chat-tool-kv__row"));
  expect(
    rows.map((row) => [textOf(row, ".chat-tool-kv__key"), textOf(row, ".chat-tool-kv__value")]),
  ).toEqual([
    ["offset:", "40"],
    ["limit:", "20"],
  ]);
});

it.each(["structured", "serialized"])("keeps %s captions out of collapsed rows", async (shape) => {
  const privateCaption =
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nPrivate synthetic caption.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
  const args = { action: "send", to: "fixture-room", message: privateCaption };
  const card = {
    id: "message-caption",
    name: "message",
    args: shape === "structured" ? args : JSON.stringify(args),
    inputText: JSON.stringify(args),
  };
  const options = { messageKey: "test-message", onToggleExpanded: vi.fn() };
  const container = await mountCard(card, { ...options, expanded: false });

  const summary = query(container, "button.chat-tool-msg-summary");
  expect(textOf(container, ".chat-tool-msg-summary__label")).toBe(
    shape === "serialized" ? "Message" : undefined,
  );
  expect(query(summary, ".chat-tool-msg-summary__icon")?.getAttribute("aria-label")).toBe(
    "message",
  );
  if (shape === "structured") {
    expect(summary?.textContent).toContain("fixture-room");
  }
  expect(summary?.textContent).not.toContain("BEGIN_OPENCLAW_INTERNAL_CONTEXT");
  expect(container.textContent).not.toContain("Private synthetic caption.");
  expect(query(container, ".chat-tool-msg-body")).toBeNull();

  await mountCard(card, { ...options }, container);
  const diagnostics = query(container, ".chat-tool-msg-body");
  expect(diagnostics?.textContent).toContain("BEGIN_OPENCLAW_INTERNAL_CONTEXT");
  expect(diagnostics?.textContent).toContain("Private synthetic caption.");
});

it("previews common intent arguments across generic tools", async () => {
  expect(resolveCollapsedToolArgumentPreview({ task: "Review the PR" })).toBe("Review the PR");
  expect(resolveCollapsedToolArgumentPreview({ prompt: "Draw a crab" })).toBe("Draw a crab");
  expect(resolveCollapsedToolArgumentPreview({ text: "First line\nSecond line" })).toBe(
    "First line",
  );
  expect(resolveCollapsedToolArgumentPreview({ query: " \r\rSecond line" })).toBe("Second line");
  const credential = ["sk", "1234567890abcdef"].join("-");
  expect(
    resolveCollapsedToolArgumentPreview({ description: `OPENAI_API_KEY=${credential}` }),
  ).toContain(credential);
});

it("marks expanded raw block-art output so QR whitespace uses block-art rendering", async () => {
  const blockArt = "  ▄▄▄▄▄▄▄  \n  █ ▄▄▄ █  \n  █▄▄▄▄▄█  ";
  const container = await mountTool("canvas_render", {
    outputText: blockArt,
    preview: canvasPreview("qr_preview"),
  });

  const rawToggle = query(container, ".chat-tool-card__raw-toggle");
  const rawBody = query(container, ".chat-tool-card__raw-body");
  expect(query(container, ".chat-tool-card__preview-frame")).toBeNull();
  expect(rawToggle?.getAttribute("aria-expanded")).toBe("false");
  expect(rawBody?.hidden).toBe(true);
  rawToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await waitForSolid(() => {
    expect(rawToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(rawBody?.hidden).toBe(false);
  });

  const code = query(container, "code.markdown-block-art");
  expect(code).not.toBeNull();
  expect(code?.textContent).toBe(blockArt);
});

it("opens assistant-surface canvas payloads in the sidebar when explicitly requested", async () => {
  const onOpenSidebar = vi.fn();
  const preview = canvasPreview("cv_sidebar");
  const { url } = preview;
  const container = await mountTool(
    "canvas_render",
    {
      outputText: JSON.stringify({
        kind: "canvas",
        view: { backend: "canvas", id: "cv_sidebar", url },
        presentation: { target: "assistant_message" },
      }),
      preview,
    },
    { onOpenSidebar },
  );

  const sidebarButton = query(container, ".chat-tool-card__action-btn");
  expect(sidebarButton).toBeInstanceOf(HTMLButtonElement);
  sidebarButton!.click();

  expect(onOpenSidebar).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "canvas",
      docId: "cv_sidebar",
      entryUrl: url,
    }),
  );
});

it.each([
  ["failed", "failed"],
  ["blocked", "Blocked"],
  ["skipped", "Skipped"],
  [undefined, "Outcome unknown"],
] as const)("reconciles %s live/history outcomes", async (status, label) => {
  const item = projectAgentActivityItem({
    itemId: "collaboration-call",
    toolCallId: "collaboration-call",
    kind: "tool",
    name: "subagents",
    title: "Delegate task",
    phase: "end",
    ...(status ? { status } : { summary: "Outcome unknown" }),
  } satisfies AgentActivityItem);
  const host = createHost({ chatRunId: "run-outcome" });
  handleAgentEvent(host, agentEvent("run-outcome", 1, "item", item));
  const live = host.chatToolMessages[0];
  expect(live).toBeDefined();
  const saved = {
    role: "assistant",
    messageId: "stored-call",
    content: [
      {
        type: "toolCall",
        id: "collaboration-call",
        name: "subagents",
        arguments: { task: "Check the report" },
      },
    ],
  };
  const history = attachHistoryActivity({
    messages: [saved],
    activity: [{ messageId: "stored-call", items: [item] }],
  });
  const container = document.createElement("div");
  const view = createActivityGroupHarness(container);
  for (const [message, runActive] of [
    [live, true],
    [history.messages[0], false],
  ] as const) {
    const group = createToolGroup("outcome", [createMessageEntry("call", message)]);
    view.render([group], { showReasoning: false, runActive });
    await settleToolBridges(container);
    expect(container.querySelectorAll(".chat-tool-failure")).toHaveLength(
      status === "failed" ? 1 : 0,
    );
    view.render([group], {
      showReasoning: false,
      runActive,
      isToolMessageExpanded: () => true,
      isToolExpanded: () => true,
    });
    await settleToolBridges(container);
    expect(textOf(container, ".chat-tool-card__outcome")).toBe(label);
    expect(query(container, ".chat-tool-row--running")).toBeNull();
    const card = extractToolCardsCached(message)[0]!;
    expect([card.outputText, card.isError]).toEqual([undefined, undefined]);
    expect(card.completed === true).toBe(message === live);
  }
  expect(live).toMatchObject({ __openclawToolStreamResultReceived: false });
  expect(saved).not.toHaveProperty("activity");
});

it.each([
  [2, "completed", false, "Exit code 2"],
  [0, "error", true, "failed"],
] as const)("shows prepared failure (%s)", async (exitCode, status, isError, label) => {
  const host = createHost({ chatRunId: "command-run" });
  const args = { command: "check-report" };
  const result = {
    content: [{ type: "text", text: "Validation report" }],
    details: { status, exitCode },
  };
  const tool = { toolCallId: "check", name: "exec" };
  const end = { phase: "result" as const, ...tool, isError, result };
  handleAgentEvent(host, agentEvent("command-run", 1, "tool", { phase: "start", ...tool, args }));
  handleAgentEvent(host, agentEvent("command-run", 2, "tool", end));
  handleAgentEvent(
    host,
    agentEvent("command-run", 3, "item", projectAgentToolActivity({ ...end, args })),
  );
  const card = extractToolCardsCached(host.chatToolMessages[0])[0]!;
  expect(card).toMatchObject({
    isError,
    exitCode,
    completed: true,
    outputText: "Validation report",
    details: result.details,
  });

  const container = await mountCard(card, {
    messageKey: "result",
    runActive: true,
    expanded: false,
  });
  expect(textOf(container, ".chat-tool-msg-summary")).toContain(label);
  await mountCard(card, { messageKey: "result", runActive: true }, container);
  expect(textOf(container, ".chat-tool-card__outcome")).toBe(label);
  expect(query(container, ".chat-tool-row--running")).toBeNull();
  expect(container.textContent).toContain("Validation report");
  expect(container.textContent).toContain("check-report");
});

it.each([
  { name: "write", args: { path: "/workspace/operation.json", content: "{}" } },
  { name: "progress_card", args: { markdown: "Preparing release" } },
  {
    name: "tool_call",
    args: { id: "web_search", args: { query: "OpenClaw release notes" } },
  },
])("shows skipped $name calls without claiming failure or success", async ({ name, args }) => {
  const container = document.createElement("div");
  const card: ToolCard = {
    id: "steering-skip",
    name,
    args,
    outputText: "Skipped to process an incoming message.",
    details: { status: "skipped", deniedReason: "steering" },
    isError: true,
    completed: true,
  };
  for (const expanded of [false, true]) {
    await mountCard(card, { expanded }, container);
    if (name === "tool_call") {
      expect(textOf(container, ".chat-tool-msg-summary")).toContain("OpenClaw release notes");
    }
    expect(container.textContent?.toLowerCase()).toContain("skipped");
    expect(container.textContent).not.toMatch(/failed|Completed|updated|Tool error/);
    expect(query(container, ".chat-tool-card--error")).toBeNull();
  }
});

it("renders Tool Search like a direct call and retains the sidebar identity", async () => {
  const name = "web_search";
  const args = { query: "OpenClaw release notes" };
  const input = { id: name, args };
  const card: ToolCard = {
    id: "search-release",
    callId: "search-release",
    name: "tool_call",
    args: input,
    inputText: JSON.stringify(input, null, 2),
    outputText: "Found the release notes.",
    completed: true,
  };
  const onOpenSidebar = vi.fn();
  for (const expanded of [false, true]) {
    const container = await mountCard(card, { expanded, onOpenSidebar });
    expect(textOf(container, ".chat-tool-msg-summary")).toContain(args.query);
    const direct = await mountCard(
      { ...card, name, args, inputText: JSON.stringify(args, null, 2) },
      { expanded, onOpenSidebar },
    );
    expect(textOf(container, ".chat-tool-msg-summary")).toBe(
      textOf(direct, ".chat-tool-msg-summary"),
    );
    expect(container.textContent).toBe(direct.textContent);
    expect(query(container, ".chat-tool-card")?.className).toBe(
      direct.querySelector(".chat-tool-card")?.className,
    );
    if (expanded) {
      query(container, ".chat-tool-card__action-btn")?.click();
      expect(onOpenSidebar.mock.calls[0]?.[0].card).toBe(card);
    }
  }
  expect([card.name, card.args]).toEqual(["tool_call", { id: name, args }]);
});

it("keeps command progress neutral across the row, expanded body, and sidebar until completion", async () => {
  const name = "exec";
  const container = document.createElement("div");
  const onOpenSidebar = vi.fn();
  const card: ToolCard = {
    id: "progress",
    name,
    args: { command: "diagnostic" },
    outputText: '{"error":"progress sample"}',
    live: true,
    completed: false,
  };
  const show = async () => await mountCard(card, { runActive: true, onOpenSidebar }, container);
  await show();
  expect(query(container, ".chat-tool-row--running")).not.toBeNull();
  expect(query(container, ".chat-tool-card--error")).toBeNull();
  expect(query(container, ".chat-tool-failure")).toBeNull();
  expect(textOf(container, ".chat-tool-card__outcome")).toBe("Running");
  expect(container.textContent).toContain(card.outputText);
  query(container, ".chat-tool-card__action-btn")?.click();
  expect(onOpenSidebar).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "tool-output", card }),
  );
  const sidebarCard = onOpenSidebar.mock.calls[0]?.[0].card;
  expect([sidebarCard.completed, sidebarCard.isError]).toEqual([false, undefined]);

  card.completed = true;
  card.isError = false;
  await show();
  expect(query(container, ".chat-tool-row--running")).toBeNull();
  expect(query(container, ".chat-tool-card--error")).toBeNull();
  expect(textOf(container, ".chat-tool-card__outcome")).toBe("Completed");
  card.isError = true;
  await show();
  expect(query(container, ".chat-tool-card--error")).not.toBeNull();
  expect(textOf(container, ".chat-tool-card__outcome")).toBe("failed");
});

it("keeps diagnostics inside expanded tool details", async () => {
  const diagnostic = "Cannot connect to the service";
  const output = JSON.stringify({ error: diagnostic });
  const outcome = "Exit code 1";

  const container = document.createElement("div");
  let expanded = false;
  const show = async () =>
    await mountTool(
      "exec",
      {
        id: "login-failure",
        isError: true,
        completed: true,
        args: { title: "Sign in to GitHub", command: "gh auth login" },
        outputText: output,
        exitCode: 1,
      },
      {
        messageKey: "login",
        expanded,
        onToggleExpanded: () => {
          expanded = !expanded;
          void show();
        },
      },
      container,
    );
  await show();
  expect(container.textContent).toContain("Sign in to GitHub");
  expect(container.textContent).not.toContain(diagnostic);
  expect(textOf(container, ".chat-tool-msg-summary")).toContain(outcome);
  expect(container.textContent).not.toContain(output);
  expect(container.textContent).not.toContain("gh auth login");
  expect(query(container, ".chat-tool-msg-body")).toBeNull();
  query(container, ".chat-tool-msg-summary")?.click();
  await settleToolBridges(container);
  expect(textOf(container, ".chat-tool-msg-body")).toContain(output);
  expect(textOf(container, ".chat-tool-card__outcome")).toBe(outcome);
  query(container, ".chat-tool-msg-summary")?.click();
  await settleToolBridges(container);
  expect(container.textContent).not.toContain(diagnostic);
});

it("renders a plain error detail when a failed tool has no output", async () => {
  const container = await mountTool("lookup", { isError: true });

  expect(query(container, ".chat-tool-card__status-badge")).toBeNull();
  expect(textOf(container, ".chat-tool-card__block-label")).toBe("Tool error");
  expect(textOf(container, ".chat-tool-card__block-content")).toBe("No output — tool failed.");
});

it.each([
  {
    args: {
      markdown: "Implementation is moving.",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "in_progress" },
        { step: "Verify", status: "pending" },
      ],
    },
    expected: "Progress updated — 1/3 · Implement",
  },
  { args: { markdown: "Waiting on review." }, expected: "Progress note updated" },
])("renders progress_card as a compact receipt: $expected", async ({ args, expected }) => {
  const container = await mountTool("progress_card", {
    args,
    outputText: "Progress card updated",
    completed: true,
  });

  expect(container.textContent?.trim()).toBe(expected);
  expect(query(container, "button")).toBeNull();
  expect(query(container, ".chat-tool-msg-body")).toBeNull();
  expect(container.textContent).not.toContain("Waiting on review.");
});

async function highlighted(card: ToolCard) {
  const container = await mountCard(card);
  onTestFinished(() => vi.dynamicImportSettled());
  await vi.dynamicImportSettled();
  return container;
}
it("highlights edit previews using their file languages", async () => {
  const container = await highlighted({
    id: "highlight",
    name: "edit",
    args: {
      path: "example.ts",
      oldText: "/* removed comment\ncontinued",
      newText: 'const value = "new";',
    },
  });
  await vi.waitFor(() => expect(textOf(container, ".tok-keyword")).toBe("const"));
  expect(textOf(container, ".tok-string")).toMatch(/"(?:old|new)"/);
});

it.each(["text", "structured"])("highlights both sides of %s renames", async (format) => {
  const before = '<section data-mode="before">Hello</section>';
  const after = 'const value = "after";';
  const args =
    format === "text"
      ? {
          patch: `*** Begin Patch\n*** Update File: example.html\n*** Move to: example.ts\n@@\n-${before}\n+${after}\n*** Add File: helper.py\n+def greet():\n+    return "hello"\n*** End Patch`,
        }
      : {
          changes: [
            {
              path: "example.html",
              kind: { type: "update", move_path: "example.ts" },
              diff: ["@@ -1 +1 @@", `-${before}`, `+${after}`].join("\n"),
            },
          ],
        };
  const container = await highlighted(
    patchCard(args, {
      id: "rename",
      ...(format === "structured" ? { outputText: "Applied patch" } : {}),
    }),
  );
  await vi.waitFor(() => {
    expect(textOf(container, ".chat-diff__row--del .tok-propertyName")).toBe("data-mode");
    expect(textOf(container, ".chat-diff__row--add .tok-keyword")).toBe("const");
  });
  expect(textOf(container, ".chat-diff__row--del .chat-diff__text")).toBe(before);
  expect(textOf(container, ".chat-diff__row--add .chat-diff__text")).toBe(after);
  if (format === "text") {
    expect(
      [...container.querySelectorAll(".tok-keyword")].map((node) => node.textContent),
    ).toContain("def");
  }
});

function promptFixture(url: string, allowExternalEmbedUrls = false) {
  const container = document.createElement("div");
  document.body.append(container);
  mountPreview(
    { ...canvas, url },
    "chat_message",
    allowExternalEmbedUrls ? { allowExternalEmbedUrls } : {},
    container,
  );
  const frame = container.querySelector("iframe");
  expect(frame).not.toBeNull();
  expect(frame!.contentWindow).not.toBeNull();
  const received: string[] = [];
  container.addEventListener(WIDGET_PROMPT_EVENT, (event) => {
    received.push((event as CustomEvent<WidgetPromptEventDetail>).detail.text);
  });
  onTestFinished(() => {
    restoreActiveElement();
    container.remove();
  });
  return { frame: frame!, received };
}

function offerPromptPort(frame: HTMLIFrameElement): MessagePort {
  const channel = new MessageChannel();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "openclaw:widget-prompt-offer" },
      origin: "null",
      source: frame.contentWindow,
      ports: [channel.port2],
    }),
  );
  return channel.port1;
}

function postPrompt(port: MessagePort, prompt: unknown) {
  port.postMessage({ type: "openclaw:widget-prompt", prompt });
}

async function flushPorts() {
  // Port delivery may take more than one macrotask on loaded CI workers.
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function emulateInteractableFrame(frame: HTMLIFrameElement) {
  // jsdom has no layout and cannot focus iframes; emulate a visible frame the
  // user clicked into, which is what the host checks require.
  (frame as HTMLIFrameElement & { checkVisibility: () => boolean }).checkVisibility = () => true;
  Object.defineProperty(document, "activeElement", { get: () => frame, configurable: true });
}

function restoreActiveElement() {
  delete (document as unknown as Record<string, unknown>).activeElement;
}

it("adopts the bridge's prompt port offer and enforces the prompt contract", async () => {
  const { frame, received } = promptFixture("/__openclaw__/canvas/documents/cv_prompt/index.html");
  // The bridge posts its offer at parse time, before the frame's load event.
  const port = offerPromptPort(frame);
  const hostMessages: unknown[] = [];
  port.addEventListener("message", (event) => hostMessages.push(event.data));
  port.start();
  frame.dispatchEvent(new Event("load"));
  await flushPorts();
  expect(hostMessages).toContainEqual({ type: "openclaw:widget-prompt-host-ready" });
  emulateInteractableFrame(frame);
  postPrompt(port, "  Show details  ");
  await flushPorts();
  expect(received).toEqual(["Show details"]);
  // Widgets may send conversation, not slash/bang commands.
  for (const invalid of ["/approve", "!pwd", "   ", 42, "x".repeat(4_001)]) {
    postPrompt(port, invalid);
  }
  await flushPorts();
  expect(received).toEqual(["Show details"]);
  // A replacement document cannot displace or re-arm the adopted grant.
  const lateOfferPort = offerPromptPort(frame);
  frame.dispatchEvent(new Event("load"));
  postPrompt(lateOfferPort, "From takeover");
  await flushPorts();
  expect(received).toEqual(["Show details"]);
  // Without focus on the frame there is no user-activation signal; drop.
  restoreActiveElement();
  postPrompt(port, "Auto send");
  await flushPorts();
  expect(received).toEqual(["Show details"]);
  // Rate limit: 10 accepted prompts per rolling minute per widget document.
  emulateInteractableFrame(frame);
  for (let index = 2; index <= 12; index += 1) {
    postPrompt(port, `Prompt ${index}`);
  }
  await flushPorts();
  expect(received).toHaveLength(10);
  expect(received.at(-1)).toBe("Prompt 10");
});

it.each([
  ["adopts late internal offers", canvasPreview("cv_late_offer").url, false, ["Late but valid"]],
  ["rejects external embed offers", "https://canvas.example/widget", true, []],
] as const)("%s", async (_label, url, external, expected) => {
  const { frame, received } = promptFixture(url, external);
  if (!external) {
    frame.dispatchEvent(new Event("load"));
  }
  const port = offerPromptPort(frame);
  if (external) {
    frame.dispatchEvent(new Event("load"));
  }
  emulateInteractableFrame(frame);
  postPrompt(port, "Late but valid");
  await flushPorts();
  expect(received).toEqual(expected);
});
