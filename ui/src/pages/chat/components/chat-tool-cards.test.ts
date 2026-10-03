/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { projectAgentActivityItem } from "../../../../../src/agents/agent-activity-presentation.js";
import { projectAgentToolActivity } from "../../../../../src/infra/agent-activity-events.js";
import { t } from "../../../i18n/index.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import {
  resolveCollapsedToolArgumentPreview,
  extractToolCardsCached,
} from "../../../lib/chat/tool-cards.ts";
import { attachHistoryActivity } from "../chat-history-request.ts";
import { agentEvent, createHost } from "../tool-stream.test-helpers.ts";
import { handleAgentEvent } from "../tool-stream.ts";
import { renderActivityGroup } from "./chat-message-group.ts";
import { createMessageEntry, createToolGroup } from "./chat-message.test-support.ts";
import { renderToolCard } from "./chat-tool-cards.ts";
import { renderToolPreview } from "./widget-card.ts";

const pluginSurface = vi.hoisted(() => ({ props: [] as unknown[] }));
vi.mock("../../../plugins/control-ui-view.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/control-ui-view.ts")>()),
  renderPluginSurface: (_surface: string, props: unknown, defaultView: unknown) => {
    pluginSurface.props.push(props);
    return defaultView;
  },
}));

const canvas = { kind: "canvas", surface: "assistant_message", render: "url" } as const;

function textOf(container: ParentNode, selector: string) {
  return container.querySelector(selector)?.textContent;
}

function mountCard(
  card: ToolCard,
  options: Partial<Parameters<typeof renderToolCard>[1]> = {},
  container = document.createElement("div"),
) {
  render(
    renderToolCard(card, {
      messageKey: "test-message",
      expanded: true,
      onToggleExpanded: vi.fn(),
      ...options,
    }),
    container,
  );
  return container;
}

describe("tool-cards", () => {
  it("routes MCP App previews through the dedicated double-iframe host", async () => {
    const container = document.createElement("div");
    const preview = { ...canvas, viewId: "cv_app", mcpApp: { viewId: "cv_app" } } as const;
    const options = { sessionKey: "agent:main:main" };
    render(renderToolPreview(preview, "chat_message", options), container);

    const view = container.querySelector("mcp-app-view");
    expect(view?.getAttribute("src")).toBeNull();
    expect(view).toMatchObject({ sessionKey: "agent:main:main", viewId: "cv_app", height: 600 });
    await customElements.whenDefined("mcp-app-view");
    expect(view).toMatchObject({ sessionKey: "agent:main:main", viewId: "cv_app" });

    const toolContainer = document.createElement("div");
    render(renderToolPreview(preview, "chat_tool", options), toolContainer);
    expect(toolContainer.querySelector("mcp-app-view")).toBeNull();
  });

  it("renders ordinary external canvas previews in an iframe", () => {
    const container = document.createElement("div");
    render(
      renderToolPreview(
        { ...canvas, viewId: "cv_canvas", url: "https://canvas.example/widget" },
        "chat_message",
        { allowExternalEmbedUrls: true },
      ),
      container,
    );
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("switches a completed patch between mutually exclusive diff and raw bodies", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    mountCard(
      {
        id: "msg:patch:multi",
        name: "apply_patch",
        args: {
          changes: [
            {
              path: "src/a.ts",
              kind: { type: "update" },
              diff: [
                "--- a/src/a.ts",
                "+++ b/src/a.ts",
                "@@ -1 +1 @@",
                "-old a",
                "+new a",
                "",
              ].join("\n"),
            },
            { path: "src/b.ts", kind: { type: "add" }, diff: "new b\n" },
          ],
        },
        outputText: "Applied patch",
      },
      {},
      container,
    );

    const diff = container.querySelector(".chat-diff");
    expect(diff?.getAttribute("aria-label")).toBe("File changes");
    const fileRows = Array.from(diff?.querySelectorAll(".chat-diff__row--file") ?? []);
    expect(fileRows.map((row) => textOf(row, ".chat-diff__text"))).toEqual([
      "Update src/a.ts",
      "Add src/b.ts",
    ]);
    expect(fileRows.every((row) => row.querySelector(".chat-diff__gutter") !== null)).toBe(true);
    expect(diff?.querySelector(".chat-diff__row--del .chat-diff__text")?.textContent).toBe("old a");
    expect(
      Array.from(diff?.querySelectorAll(".chat-diff__row--add .chat-diff__text") ?? []).map(
        (row) => row.textContent,
      ),
    ).toEqual(["new a", "new b"]);

    const tabGroup = container.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
      "wa-tab-group",
    );
    const tabs = Array.from(
      container.querySelectorAll<HTMLElement & { updateComplete: Promise<unknown> }>("wa-tab"),
    );
    await tabGroup?.updateComplete;
    await Promise.all(tabs.map((tab) => tab.updateComplete));
    expect(
      tabGroup?.shadowRoot?.querySelector('[role="tablist"]')?.getAttribute("aria-label"),
    ).toBe("Tool detail view");
    expect(tabs.map((tab) => [tab.textContent?.trim(), tab.getAttribute("aria-selected")])).toEqual(
      [
        ["Diff", "true"],
        ["Raw", "false"],
      ],
    );
    const diffBody = container.querySelector<HTMLElement>('wa-tab-panel[name="diff"]');
    const rawBody = container.querySelector<HTMLElement>('wa-tab-panel[name="raw"]');
    expect(diffBody?.hasAttribute("active")).toBe(true);
    expect(rawBody?.hasAttribute("active")).toBe(false);

    tabs[1]?.click();
    await tabGroup?.updateComplete;
    await Promise.all(tabs.map((tab) => tab.updateComplete));
    expect(diffBody?.hasAttribute("active")).toBe(false);
    expect(rawBody?.hasAttribute("active")).toBe(true);
    expect(rawBody?.querySelector("code")?.textContent).toBe("Applied patch");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);

    tabGroup?.setAttribute("aria-label", "Translated tool detail view");
    mountCard(
      {
        id: "msg:patch:multi",
        name: "apply_patch",
        args: { changes: [{ path: "src/a.ts", kind: { type: "update" }, diff: "-old\n+new\n" }] },
        outputText: "Applied patch",
      },
      {},
      container,
    );
    await tabGroup?.updateComplete;
    expect(
      tabGroup?.shadowRoot?.querySelector('[role="tablist"]')?.getAttribute("aria-label"),
    ).toBe("Tool detail view");
    container.remove();
  });

  it("shows failed edit output before the attempted diff", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    mountCard(
      {
        id: "msg:edit:failed",
        name: "edit",
        args: { path: "src/a.ts", oldText: "before", newText: "after" },
        outputText: "Patch context did not match",
        completed: true,
        isError: true,
      },
      {},
      container,
    );

    const tabGroup = container.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
      "wa-tab-group",
    );
    await tabGroup?.updateComplete;

    expect(container.querySelector('wa-tab[panel="raw"]')?.hasAttribute("active")).toBe(true);
    expect(container.querySelector('wa-tab-panel[name="raw"]')?.hasAttribute("active")).toBe(true);
    expect(textOf(container, 'wa-tab-panel[name="raw"] code')).toBe("Patch context did not match");
    container.remove();
  });

  it("labels a completed Codex file creation from its recorded operation", () => {
    const onOpenWorkspaceFile = vi.fn();
    const onToggleExpanded = vi.fn();
    const container = mountCard(
      {
        id: "msg:patch:add",
        name: "apply_patch",
        args: {
          changes: [
            { path: "src/new.ts", kind: { type: "add" }, diff: "export const created = true;\n" },
          ],
        },
        completed: true,
      },
      { expanded: false, onOpenWorkspaceFile, onToggleExpanded },
    );

    expect(textOf(container, ".chat-tool-row__verb")).toBe("Created");
    expect(textOf(container, ".chat-tool-row__file-link")?.trim()).toBe("new.ts");
    container.querySelector<HTMLButtonElement>(".chat-tool-row__file-link")?.click();
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith({ path: "src/new.ts" });
    expect(onToggleExpanded).not.toHaveBeenCalled();

    expect(container.querySelector(".chat-tool-row__toggle")?.getAttribute("aria-label")).toBe(
      "Created new.ts",
    );
    container.querySelector<HTMLButtonElement>(".chat-tool-row__toggle")?.click();
    expect(onToggleExpanded).toHaveBeenCalledWith("msg:patch:add");
    expect(onOpenWorkspaceFile).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "multi-file",
      patch: [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@",
        "-old",
        "+new",
        "*** Add File: src/b.ts",
        "+added",
        "*** End Patch",
      ].join("\n"),
      target: "2 files",
    },
    {
      label: "moved",
      patch: [
        "*** Begin Patch",
        "*** Update File: src/old.ts",
        "*** Move to: src/new.ts",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
      target: "old.ts → new.ts",
    },
    {
      // A successful delete removes its own target, so the workspace loader
      // would only ever report "Failed to load".
      label: "deleted",
      patch: ["*** Begin Patch", "*** Delete File: src/gone.ts", "*** End Patch"].join("\n"),
      target: "gone.ts",
    },
  ])("keeps $label patch summaries non-navigable", ({ patch, target }) => {
    const onOpenWorkspaceFile = vi.fn();
    const onToggleExpanded = vi.fn();
    const container = mountCard(
      { id: `msg:patch:${target}`, name: "apply_patch", args: { patch }, completed: true },
      { expanded: false, onOpenWorkspaceFile, onToggleExpanded },
    );

    expect(container.querySelector(".chat-tool-row--file")).toBeNull();
    expect(textOf(container, ".chat-tool-row__target")).toBe(target);
    container.querySelector<HTMLButtonElement>(".chat-tool-msg-summary")?.click();
    expect(onToggleExpanded).toHaveBeenCalledOnce();
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
  });

  it("renders edit and write rows from their result outcome", () => {
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
        const container = mountCard({ id: name, name, args, ...card }, { runActive });
        expect(textOf(container, ".chat-tool-row__verb")).toBe(verbs[verb]);
        expect(container.querySelector(".chat-diff")?.getAttribute("aria-label")).toBe(label);
        expect(container.querySelector(".chat-diffstat") !== null).toBe(hasStat);
        if (failed) {
          expect(textOf(container, ".chat-tool-card__outcome")).toBe("failed");
        }
        expect(container.querySelector(".chat-tool-msg-summary--error")).toBeNull();
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
    try {
      mountCard(
        {
          id: "copy",
          name: "apply_patch",
          completed: true,
          args: {
            changes: [
              {
                path: "src/patch.ts",
                kind: { type: "update" },
                diff: "--- a/src/patch.ts\n+++ b/src/patch.ts\n@@ -1 +1 @@\n-old patch\n+new patch\n",
              },
            ],
          },
        },
        { onOpenSidebar },
        container,
      );
      const copyButton = container.querySelector<HTMLButtonElement>(
        '.chat-tool-card__actions button[aria-label="Copy"]',
      );
      expect(copyButton).toBeInstanceOf(HTMLButtonElement);
      copyButton!.click();
      await vi.waitFor(() => expect(copyButton!.getAttribute("aria-label")).toBe(feedback));
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("new patch"));
      const status = copyButton!.parentElement?.querySelector<HTMLElement>('[role="status"]');
      expect(status?.textContent).toBe(feedback);
      expect(status?.hidden).toBe(false);
      const sidebarButton = container.querySelector<HTMLButtonElement>(
        `.chat-tool-card__actions button[aria-label="${t("chat.toolCards.openDetails")}"]`,
      );
      expect(sidebarButton).toBeInstanceOf(HTMLButtonElement);
      sidebarButton!.click();
      expect(onOpenSidebar).toHaveBeenCalledOnce();
    } finally {
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("opens the raw file path from an expanded read card", () => {
    const { name, args, path } = {
      name: "read",
      args: { path: "packages/app/src/read.ts" },
      path: "packages/app/src/read.ts",
    };
    const onOpenWorkspaceFile = vi.fn();
    const container = mountCard(
      { id: `msg:${name}:open`, name, args, completed: true },
      { onOpenWorkspaceFile },
    );

    const pathButton = container.querySelector<HTMLButtonElement>(
      '.chat-tool-card__detail-link[title="Open file"]',
    );
    expect(pathButton).toBeInstanceOf(HTMLButtonElement);
    pathButton!.click();
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith({ path });
  });

  it("keeps read offsets and limits visible in expanded args", () => {
    const container = mountCard({
      id: "msg:read:range",
      name: "read",
      args: { path: "/repo/src/a.ts", offset: 40, limit: 20 },
      inputText: JSON.stringify({ path: "/repo/src/a.ts", offset: 40, limit: 20 }),
    });

    expect(textOf(container, ".chat-tool-row__verb")).toBe("Read");
    const rows = Array.from(container.querySelectorAll(".chat-tool-kv__row"));
    expect(
      rows.map((row) => [textOf(row, ".chat-tool-kv__key"), textOf(row, ".chat-tool-kv__value")]),
    ).toEqual([
      ["offset:", "40"],
      ["limit:", "20"],
    ]);
  });

  it.each(["structured", "serialized"])(
    "keeps %s message captions in expanded diagnostics, not the collapsed row",
    (shape) => {
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
      const container = mountCard(card, { ...options, expanded: false });

      const summary = container.querySelector("button.chat-tool-msg-summary");
      expect(textOf(container, ".chat-tool-msg-summary__label")).toBe(
        shape === "serialized" ? "Message" : undefined,
      );
      expect(
        summary?.querySelector(".chat-tool-msg-summary__icon")?.getAttribute("aria-label"),
      ).toBe("message");
      if (shape === "structured") {
        expect(summary?.textContent).toContain("fixture-room");
      }
      expect(summary?.textContent).not.toContain("BEGIN_OPENCLAW_INTERNAL_CONTEXT");
      expect(container.textContent).not.toContain("Private synthetic caption.");
      expect(container.querySelector(".chat-tool-msg-body")).toBeNull();

      mountCard(card, { ...options }, container);
      const diagnostics = container.querySelector(".chat-tool-msg-body");
      expect(diagnostics?.textContent).toContain("BEGIN_OPENCLAW_INTERNAL_CONTEXT");
      expect(diagnostics?.textContent).toContain("Private synthetic caption.");
    },
  );

  it("previews common intent arguments across generic tools", () => {
    expect(resolveCollapsedToolArgumentPreview({ task: "Review the PR" })).toBe("Review the PR");
    expect(resolveCollapsedToolArgumentPreview({ prompt: "Draw a crab" })).toBe("Draw a crab");
    expect(resolveCollapsedToolArgumentPreview({ text: "First line\nSecond line" })).toBe(
      "First line",
    );
    expect(resolveCollapsedToolArgumentPreview({ query: " \r\rSecond line" })).toBe("Second line");
    const credential = ["sk", "1234567890abcdef"].join("-");
    expect(
      resolveCollapsedToolArgumentPreview({ description: `OPENAI_API_KEY=${credential}` }),
    ).not.toContain(credential);
  });

  it("marks expanded raw block-art output so QR whitespace uses block-art rendering", () => {
    const blockArt = "  ▄▄▄▄▄▄▄  \n  █ ▄▄▄ █  \n  █▄▄▄▄▄█  ";
    const container = mountCard({
      id: "msg:view:block-art",
      name: "canvas_render",
      outputText: blockArt,
      preview: {
        ...canvas,
        viewId: "qr_preview",
        url: "/__openclaw__/canvas/documents/qr_preview/index.html",
      },
    });

    const rawToggle = container.querySelector<HTMLButtonElement>(".chat-tool-card__raw-toggle");
    const rawBody = container.querySelector<HTMLElement>(".chat-tool-card__raw-body");
    expect(container.querySelector(".chat-tool-card__preview-frame")).toBeNull();
    expect(rawToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(rawBody?.hidden).toBe(true);
    rawToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(rawToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(rawBody?.hidden).toBe(false);

    const code = container.querySelector("code.markdown-block-art");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe(blockArt);
  });

  it("opens assistant-surface canvas payloads in the sidebar when explicitly requested", () => {
    const onOpenSidebar = vi.fn();
    const container = mountCard(
      {
        id: "msg:view:8",
        name: "canvas_render",
        outputText: JSON.stringify({
          kind: "canvas",
          view: {
            backend: "canvas",
            id: "cv_sidebar",
            url: "/__openclaw__/canvas/documents/cv_sidebar/index.html",
            title: "Player",
            preferred_height: 360,
          },
          presentation: { target: "assistant_message" },
        }),
        preview: {
          ...canvas,
          viewId: "cv_sidebar",
          url: "/__openclaw__/canvas/documents/cv_sidebar/index.html",
          title: "Player",
          preferredHeight: 360,
        },
      },
      { onOpenSidebar },
    );

    const sidebarButton = container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn");
    expect(sidebarButton).toBeInstanceOf(HTMLButtonElement);
    sidebarButton!.click();

    expect(onOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "canvas",
        docId: "cv_sidebar",
        entryUrl: "/__openclaw__/canvas/documents/cv_sidebar/index.html",
      }),
    );
  });
});

describe("tool-card outcomes", () => {
  it.each([
    { status: "failed", label: "failed" },
    { status: "blocked", label: "Blocked" },
    { status: "skipped", label: "Skipped" },
    { status: undefined, label: "Outcome unknown" },
  ] as const)(
    "preserves prepared $status outcomes through live items and history attachment",
    ({ status, label }) => {
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
      for (const [message, runActive] of [
        [live, true],
        [history.messages[0], false],
      ] as const) {
        const group = createToolGroup("outcome", [createMessageEntry("call", message)]);
        render(renderActivityGroup([group], { showReasoning: false, runActive }), container);
        expect(container.querySelectorAll(".chat-tool-failure")).toHaveLength(
          status === "failed" ? 1 : 0,
        );
        render(
          renderActivityGroup([group], {
            showReasoning: false,
            runActive,
            isToolMessageExpanded: () => true,
            isToolExpanded: () => true,
          }),
          container,
        );
        expect(textOf(container, ".chat-tool-card__outcome")).toBe(label);
        expect(container.querySelector(".chat-tool-row--running")).toBeNull();
        const card = extractToolCardsCached(message)[0]!;
        expect(card.outputText).toBeUndefined();
        expect(card.isError).toBeUndefined();
        expect(card.completed).not.toBe(true);
      }
      expect(live).toMatchObject({ __openclawToolStreamResultReceived: false });
      expect(saved).not.toHaveProperty("activity");
    },
  );

  it("keeps a prepared nonzero exit failed without rewriting the raw tool result", () => {
    const host = createHost({ chatRunId: "command-run" });
    const args = { command: "check-report" };
    const result = {
      content: [{ type: "text", text: "Validation report" }],
      details: { status: "completed", exitCode: 2 },
    };
    const tool = { toolCallId: "check", name: "exec" };
    const end = { phase: "result" as const, ...tool, isError: false, result };
    handleAgentEvent(host, agentEvent("command-run", 1, "tool", { phase: "start", ...tool, args }));
    handleAgentEvent(host, agentEvent("command-run", 2, "tool", end));
    handleAgentEvent(
      host,
      agentEvent("command-run", 3, "item", projectAgentToolActivity({ ...end, args })),
    );
    const card = extractToolCardsCached(host.chatToolMessages[0])[0]!;
    expect(card).toMatchObject({
      isError: false,
      completed: true,
      outputText: "Validation report",
      details: result.details,
    });

    const container = mountCard(card, { messageKey: "result", runActive: true });
    expect(textOf(container, ".chat-tool-card__outcome")).toBe("Exit code 2");
    expect(container.querySelector(".chat-tool-row--running")).toBeNull();
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
  ])("shows skipped $name calls without claiming failure or success", ({ name, args }) => {
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
      mountCard(card, { expanded }, container);
      if (name === "tool_call") {
        expect(textOf(container, ".chat-tool-msg-summary")).toContain("OpenClaw release notes");
      }
      expect(container.textContent?.toLowerCase()).toContain("skipped");
      expect(container.textContent).not.toMatch(/failed|Completed|updated|Tool error/);
      expect(container.querySelector(".chat-tool-card--error")).toBeNull();
    }
  });

  it.each([
    {
      name: "web_search",
      args: { query: "OpenClaw release notes" },
      text: "OpenClaw release notes",
    },
    { name: "read", args: { path: "/workspace/CHANGELOG.md" }, text: "CHANGELOG.md" },
    {
      name: "exec",
      args: { command: "check-release", title: "Check the release" },
      text: "Check the release",
    },
  ])(
    "renders a Tool Search $name like a direct call and retains the sidebar identity",
    ({ name, args, text }) => {
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
        const container = mountCard(card, { expanded, onOpenSidebar });
        expect(textOf(container, ".chat-tool-msg-summary")).toContain(text);
        const direct = mountCard(
          { ...card, name, args, inputText: JSON.stringify(args, null, 2) },
          { expanded, onOpenSidebar },
        );
        expect(container.innerHTML).toBe(direct.innerHTML);
        if (expanded) {
          container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn")?.click();
          expect(onOpenSidebar.mock.calls[0]?.[0].card).toBe(card);
        }
      }
      expect(card.name).toBe("tool_call");
      expect(card.args).toEqual({ id: name, args });
    },
  );

  it("passes the raw Tool Search invocation to tool-result plugin replacements", () => {
    const input = { id: "web_search", args: { query: "OpenClaw release notes" } };
    const card: ToolCard = {
      id: "search-release",
      callId: "search-release",
      name: "tool_call",
      args: input,
      outputText: "Found the release notes.",
      completed: true,
    };
    for (const expanded of [false, true]) {
      pluginSurface.props.length = 0;
      mountCard(card, { expanded });
      expect(pluginSurface.props).toEqual([
        expect.objectContaining({
          toolName: "tool_call",
          toolCallId: "search-release",
          input,
          output: expect.objectContaining({ text: "Found the release notes." }),
        }),
      ]);
    }
  });

  it("keeps command progress neutral across the row, expanded body, and sidebar until completion", () => {
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
    const show = () => mountCard(card, { runActive: true, onOpenSidebar }, container);
    show();
    expect(container.querySelector(".chat-tool-row--running")).not.toBeNull();
    expect(container.querySelector(".chat-tool-card--error")).toBeNull();
    expect(container.querySelector(".chat-tool-failure")).toBeNull();
    expect(textOf(container, ".chat-tool-card__outcome")).toBe("Running");
    expect(container.textContent).toContain(card.outputText);
    container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn")?.click();
    expect(onOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tool-output", card }),
    );
    expect(onOpenSidebar.mock.calls[0]?.[0].card.completed).toBe(false);
    expect(onOpenSidebar.mock.calls[0]?.[0].card.isError).toBeUndefined();

    card.completed = true;
    card.isError = false;
    show();
    expect(container.querySelector(".chat-tool-row--running")).toBeNull();
    expect(container.querySelector(".chat-tool-card--error")).toBeNull();
    expect(textOf(container, ".chat-tool-card__outcome")).toBe("Completed");
    card.isError = true;
    show();
    expect(container.querySelector(".chat-tool-card--error")).not.toBeNull();
    expect(textOf(container, ".chat-tool-card__outcome")).toBe("failed");
  });

  it("keeps diagnostics inside expanded tool details", () => {
    const diagnostic = "Cannot connect to the service";
    const output = JSON.stringify({ error: diagnostic });
    const exitCode = 1;
    const outcome = "Exit code 1";

    const container = document.createElement("div");
    let expanded = false;
    const show = () =>
      mountCard(
        {
          id: "login-failure",
          name: "exec",
          isError: true,
          completed: true,
          args: { title: "Sign in to GitHub", command: "gh auth login" },
          outputText: output,
          exitCode,
        },
        {
          messageKey: "login",
          expanded,
          onToggleExpanded: () => {
            expanded = !expanded;
            show();
          },
        },
        container,
      );
    show();
    expect(container.textContent).toContain("Sign in to GitHub");
    expect(container.textContent).not.toContain(diagnostic);
    expect(textOf(container, ".chat-tool-msg-summary")).toContain(outcome);
    expect(container.textContent).not.toContain(output);
    expect(container.textContent).not.toContain("gh auth login");
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
    container.querySelector<HTMLButtonElement>(".chat-tool-msg-summary")?.click();
    expect(textOf(container, ".chat-tool-msg-body")).toContain(output);
    expect(textOf(container, ".chat-tool-card__outcome")).toBe(outcome);
    container.querySelector<HTMLButtonElement>(".chat-tool-msg-summary")?.click();
    expect(container.textContent).not.toContain(diagnostic);
  });

  it("renders a plain error detail when a failed tool has no output", () => {
    const container = mountCard({ id: "msg:err:no-output", name: "lookup", isError: true });

    expect(container.querySelector(".chat-tool-card__status-badge")).toBeNull();
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
  ])("renders progress_card as a compact receipt: $expected", ({ args, expected }) => {
    const container = mountCard({
      id: `progress:${expected}`,
      name: "progress_card",
      args,
      outputText: "Progress card updated",
      completed: true,
    });

    expect(container.textContent?.trim()).toBe(expected);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
    expect(container.textContent).not.toContain("Waiting on review.");
  });
});

describe("tool-card source highlighting", () => {
  async function highlighted(card: ToolCard) {
    const container = mountCard(card);
    onTestFinished(async () => {
      await vi.dynamicImportSettled();
      render(null, container);
    });
    await vi.dynamicImportSettled();
    return container;
  }
  it("highlights edit previews using their file languages", async () => {
    const card = {
      name: "edit",
      args: {
        path: "example.ts",
        oldText: "/* removed comment\ncontinued",
        newText: 'const value = "new";',
      },
    };
    const container = await highlighted({ id: "highlight", ...card });
    await vi.waitFor(() => expect(textOf(container, ".tok-keyword")).toBe("const"));
    expect(textOf(container, ".tok-string")).toMatch(/"(?:old|new)"/);
  });

  it.each([
    { format: "text", multiple: true },
    { format: "structured", multiple: false },
  ])(
    "highlights each side of a $format rename with multiple=$multiple",
    async ({ format, multiple }) => {
      const before = '<section data-mode="before">Hello</section>';
      const after = 'const value = "after";';
      const args =
        format === "text"
          ? {
              patch: [
                "*** Begin Patch",
                "*** Update File: example.html",
                "*** Move to: example.ts",
                "@@",
                `-${before}`,
                `+${after}`,
                "*** Add File: helper.py",
                "+def greet():",
                '+    return "hello"',
                "*** End Patch",
              ].join("\n"),
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
      const container = await highlighted({
        id: "rename",
        name: "apply_patch",
        args,
        ...(format === "structured" ? { outputText: "Applied patch" } : {}),
      });
      await vi.waitFor(() => {
        expect(textOf(container, ".chat-diff__row--del .tok-propertyName")).toBe("data-mode");
        expect(textOf(container, ".chat-diff__row--add .tok-keyword")).toBe("const");
      });
      expect(textOf(container, ".chat-diff__row--del .chat-diff__text")).toBe(before);
      expect(textOf(container, ".chat-diff__row--add .chat-diff__text")).toBe(after);
      if (multiple) {
        expect(
          [...container.querySelectorAll(".tok-keyword")].map((node) => node.textContent),
        ).toContain("def");
      }
    },
  );
});
