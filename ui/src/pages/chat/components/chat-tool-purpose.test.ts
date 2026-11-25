/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { jsonResult } from "../../../../../src/agents/tools/tool-results.js";
import { projectCatalogItemForDisplay } from "../../../../../src/chat/session-catalog-display.js";
import { projectToolResultDetails } from "../../../../../src/gateway/chat-display-projection.canvas.js";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { agentEvent, createHost } from "../tool-stream.test-helpers.ts";
import { handleAgentEvent } from "../tool-stream.ts";
import { mountCard } from "./chat-tool-cards.test-support.tsx";
import { catalogToolOperation } from "./chat-tool-operation-copy.ts";

const text = (container: ParentNode, selector: string) =>
  container.querySelector(selector)?.textContent;

it.each([
  [
    "message",
    { emoji: "✅" },
    { ok: false, added: "✅", warning: "Reaction unavailable: ✅" },
    "React to message",
  ],
  [
    "tool_call",
    { emoji: "" },
    {
      ok: false,
      reason: "disabled",
      hint: "Telegram reactions are disabled via actions.reactions. Do not retry.",
    },
    "Clear reactions",
  ],
] as const)(
  "keeps a refused Telegram reaction neutral through %s",
  async (name, intent, receipt, label) => {
    const args = { action: "react", channel: "telegram", messageId: "456", ...intent };
    const result = jsonResult(receipt);
    const tool = { id: "message", name: "message", source: "openclaw" };
    const dispatch = name === "tool_call";
    const input = dispatch ? { id: tool.id, args } : args;
    const details = dispatch ? { tool, result, status: "failed" } : result.details;
    const toolCallId = "telegram-reaction";
    const host = createHost({ chatRunId: toolCallId });
    handleAgentEvent(
      host,
      agentEvent(toolCallId, 1, "tool", { phase: "start", toolCallId, name, args: input }),
    );
    // A capture without outer text must still honor the dispatcher's inner details.
    handleAgentEvent(
      host,
      agentEvent(toolCallId, 2, "tool", {
        phase: "result",
        toolCallId,
        name,
        result: dispatch ? { text: "", details } : result,
      }),
    );
    // A completed catalog call can retain just the serialized result, without native details.
    const history = projectCatalogItemForDisplay({
      type: "toolResult",
      toolName: name,
      toolCallId,
      toolInput: input,
      isError: false,
      raw: { result: dispatch ? { tool, result: { content: result.content } } : receipt },
    });
    const titles = [];
    for (const message of [host.chatToolMessages[0], history]) {
      const card = extractToolCardsCached(message)[0]!;
      const container = await mountCard(card, { expanded: false });
      titles.push(text(container, ".chat-tool-row__title"));
      if (!dispatch || message === history) {
        await mountCard(card, { expanded: true }, container);
        expect(text(container, ".chat-tool-msg-body")).toContain(
          "warning" in receipt ? receipt.warning : receipt.hint,
        );
      }
    }
    expect(titles).toEqual([label, label]);
  },
);

it.each([
  [{ ok: true, messageId: "reply-guid", repliedTo: "parent-guid" }, "Replied to message"],
  [{ ok: true, messageId: "unknown", repliedTo: "parent-guid" }, "Reply to message"],
  [{ ok: true, messageId: "ok", repliedTo: "parent-guid" }, "Reply to message"],
  [{ ok: true, dryRun: true, channel: "imessage", action: "reply" }, "Reply to message"],
  [{ status: "suppressed", reason: "poll_vote_echo" }, "Reply to message"],
  [{ error: "iMessage action timed out after 5000ms" }, "Reply to message"],
  [undefined, "Reply to message"],
] as const)(
  "labels a recorded iMessage reply from its outbound receipt: %j",
  async (payload, label) => {
    const args = {
      action: "reply",
      channel: "imessage",
      chatGuid: "iMessage;+;fixture",
      messageId: "parent-guid",
      message: "Fixture reply",
    };
    const result = payload && jsonResult(payload);
    const isError = Boolean(payload && "error" in payload);
    const [card] = extractToolCardsCached({
      role: "assistant",
      content: [
        { type: "toolcall", id: "reply", name: "message", arguments: args },
        {
          type: "toolresult",
          id: "reply",
          name: "message",
          isError,
          content: result?.content ?? [],
          details: projectToolResultDetails(result?.details, 4_096, { name: "message" }).details,
        },
      ],
    });
    expect(card?.args).toEqual(args);
    const container = await mountCard(card!, { expanded: false });
    expect(text(container, ".chat-tool-row__title")).toBe(label);
  },
);

it.each([
  [{ live: true }, "Checking goal"],
  [{ completed: true }, "Checked goal"],
  [{ completed: true, isError: true }, "Check goal"],
  [{}, "Check goal"],
] as const)(
  "describes a goal lookup without implying pursuit or completion: %j",
  async (state, label) => {
    const container = await mountCard(
      { id: "goal-lookup", name: "mcp__openclaw__get_goal", args: {}, ...state },
      { messageKey: "goal-lookup", expanded: false, runActive: true },
    );
    expect(text(container, ".chat-tool-row__title")).toBe(label);
  },
);

it.each([
  ["wait", { runId: "cm_test" }, "Waited for tool result"],
  ["ask_user", { questions: [{ question: "Do not repeat this prompt" }] }, "Asked you a question"],
  ["tool_call", { id: "openclaw:core:wait", args: { runId: "cm_test" } }, "Waited for tool result"],
  ["custom_tool", { text: "Inspect the workspace" }, "Custom Tool"],
  [
    "ToolSearch",
    { query: "select:mcp__openclaw__exec,mcp__openclaw__sessions_send" },
    "Selected tools",
  ],
  ["ToolSearch", { query: "find session tools" }, "Searched tools"],
  ["mcp__openclaw__tool_search", { query: "session tools" }, "Searched tools"],
  ["mcp__openclaw__sessions_list", { limit: 200 }, "Listed chats"],
  ["sessions_list", { search: "00000000-0000-4000-8000-000000007ef3" }, "Listed chats"],
] as const)(
  "keeps %s factual while retaining its input for inspection",
  async (name, args, label) => {
    const container = document.createElement("div");
    for (const expanded of [false, true]) {
      await mountCard(
        { id: "no-detail", name, args, inputText: JSON.stringify(args), completed: true },
        { messageKey: "no-detail", expanded },
        container,
      );
      expect(text(container, ".chat-tool-disclosure__content")?.trim()).toBe(label);
      if (expanded) {
        for (const field of ["text", "query", "search", "limit"] as const) {
          if (field in args) {
            expect(text(container, ".chat-tool-msg-body")).toContain(
              String(args[field as keyof typeof args]),
            );
          }
        }
      }
    }
  },
);

it.each([
  [
    "kill",
    { status: "completed", cancellationRequested: true, terminationConfirmed: false },
    "Requested process stop",
  ],
  ["clear", { status: "completed" }, "Removed finished process record"],
] as const)("describes what a completed process %s call did", async (action, details, label) => {
  const container = await mountCard(
    { id: action, name: "process", args: { action, sessionId: "job" }, completed: true, details },
    { expanded: false },
  );
  expect(text(container, ".chat-tool-row__title")).toBe(label);
});

it.each([
  [
    "knowledge_attach",
    { final: false },
    { state: "uploading", receivedBytes: 3 },
    "Uploaded knowledge source data",
  ],
  [
    "knowledge_attach",
    { final: true },
    { state: "complete", receivedBytes: 3 },
    "Finished uploading knowledge source file",
  ],
  [
    "knowledge_relink",
    { dryRun: true },
    { dryRun: true, linked: 2 },
    "Previewed links for remembered claims",
  ],
  [
    "knowledge_relink",
    {},
    { dryRun: false, scanned: 0, linked: 0 },
    "Checked remembered claims for missing links",
  ],
  ["knowledge_relink", {}, { dryRun: false, linked: 2 }, "Relinked remembered claims"],
  ["knowledge_relink", {}, { dryRun: true, linked: 2 }, "Previewed links for remembered claims"],
  [
    "knowledge_verify",
    { records: [{ id: "decision" }] },
    { checked: 1, passed: 1, failed: 0 },
    "Verified knowledge publication",
  ],
  [
    "knowledge_verify",
    { records: [{ id: "missing" }] },
    { checked: 1, passed: 0, failed: 1 },
    "Checked knowledge publication",
  ],
  ["knowledge_verify", { records: [{ id: "decision" }] }, {}, "Checked knowledge publication"],
] as const)(
  "reports the recorded Knowledge operation: %s %j",
  async (name, args, result, label) => {
    const container = await mountCard(
      {
        id: "knowledge",
        name: "tool_call",
        args: { id: `openclaw:knowledge:${name}`, args },
        completed: true,
        outputText: JSON.stringify({
          tool: { name },
          result: { content: [{ type: "text", text: JSON.stringify(result) }] },
        }),
      },
      { expanded: false },
    );
    expect(text(container, ".chat-tool-disclosure__content")).toBe(label);
  },
);

it.each([
  ["knowledge_relink", {}, { dryRun: false, linked: 2 }, "Relinked remembered claims"],
  [
    "knowledge_verify",
    { records: [{ id: "decision" }] },
    { checked: 1, passed: 1, failed: 0 },
    "Verified knowledge publication",
  ],
] as const)(
  "reads the retained dispatcher result for %s when the text is omitted",
  async (name, args, result, label) => {
    const container = await mountCard(
      {
        id: "knowledge",
        name: "tool_call",
        args: { id: `openclaw:knowledge:${name}`, args },
        completed: true,
        details: { tool: { name }, result: { details: result } },
      },
      { expanded: false },
    );
    expect(text(container, ".chat-tool-disclosure__content")).toBe(label);
  },
);

it.each([
  ["memory_search", "query", ["release checklist", "travel plans"], "Searched memory for"],
  ["wiki_get", "lookup", ["projects/openclaw", "people/alex"], "Read wiki page"],
] as const)(
  "keeps two %s calls distinguishable by their %s",
  async (name, field, values, prefix) => {
    const titles = [];
    for (const value of values) {
      const container = await mountCard(
        { id: `${name}-${value}`, name, args: { [field]: value }, completed: true },
        { expanded: false },
      );
      titles.push(text(container, ".chat-tool-row__title"));
    }
    expect(titles).toEqual(values.map((value) => `${prefix} “${value}”`));
  },
);

const recordFence = { id: "claim-earlier", expectedRevision: 1, expectedHash: "1".repeat(64) };
const request = {
  requestId: "00000000-0000-4000-8000-000000000123",
  reason: "The final report replaces the earlier finding.",
};
const supersede = {
  ...request,
  by: { ...recordFence, id: "claim-latest" },
  superseded: [recordFence],
};
const reconcile = {
  ...request,
  ...recordFence,
  expectedVaultId: "00000000-0000-4000-8000-000000000456",
  expectedOntologyFingerprint: "2".repeat(64),
  representation: "compact",
  dryRun: false,
};
const saved = { id: recordFence.id, revision: 2, hash: "3".repeat(64) };
const conflictMessage =
  "Concurrent filesystem change preserved. Publication is blocked; retained before/after material requires recovery review. No automatic overwrite or rollback.";

function recordedCard(name: string, args: unknown, output?: string, details?: unknown) {
  return extractToolCardsCached({
    role: "assistant",
    content: [
      { type: "toolCall", id: "knowledge-call", name, arguments: args },
      {
        type: "toolResult",
        toolCallId: "knowledge-call",
        name,
        content: output ? [{ type: "text", text: output }] : [],
        details,
      },
    ],
  })[0]!;
}

// Core UI tests cannot import the Knowledge plugin contract; these are its receipt-returning tools.
it.each([
  "knowledge_annotate",
  "knowledge_correct",
  "knowledge_create_claim",
  "knowledge_create_relationship",
  "knowledge_edit_body",
  "knowledge_extract_section",
  "knowledge_merge",
  "knowledge_publish_batch",
  "knowledge_recall",
  "knowledge_reconcile_evidence",
  "knowledge_resume",
  "knowledge_save_page",
  "knowledge_supersede",
  "knowledge_unmerge",
  "knowledge_withdraw",
])("qualifies an accepted %s publication receipt", (name) => {
  const details = { ...saved, state: "accepted", message: "Accepted for publication." };
  expect(catalogToolOperation({ id: name, name, details }, "succeeded")?.label).toMatch(
    / · pending publication$/u,
  );
});

it("distinguishes a page edit's outcome from inspecting its receipt", async () => {
  const page = { ...saved, id: "page-field-notes" };
  const edit = {
    requestId: request.requestId,
    id: page.id,
    expectedRevision: 1,
    expectedHash: recordFence.expectedHash,
    title: "Field notes",
    body: "Revised notes.",
  };
  const conflict = { ...page, state: "conflict", message: conflictMessage };
  for (const [name, args, result, label] of [
    ["knowledge_save_page", edit, conflict, "Save knowledge page · not applied"],
    ["knowledge_save_page", edit, page, "Saved knowledge page"],
    [
      "knowledge_mutation",
      { requestId: edit.requestId },
      { receipt: conflict },
      "Inspected knowledge publication",
    ],
  ] as const) {
    const tool = { id: `openclaw:knowledge:${name}`, name };
    for (const card of [
      recordedCard(name, args, JSON.stringify(result)),
      recordedCard("dispatch_action", { id: tool.id, args }, undefined, {
        tool,
        result: { details: result },
      }),
    ]) {
      expect(
        text(await mountCard(card, { expanded: false }), ".chat-tool-disclosure__content"),
      ).toBe(label);
    }
  }
});

it("uses remember's nested publication receipt rather than its planned item status", async () => {
  const name = "knowledge_remember";
  const tool = { id: "openclaw:knowledge:knowledge_remember", name };
  const excerpt = "The synthetic logbook uses metric units.";
  const args = {
    requestId: request.requestId,
    attribution: "Field notes",
    excerpt,
    items: [{ text: excerpt, kind: "fact" }],
  };
  const inserted = { id: saved.id, subject: "none", status: "inserted" };
  const items = [inserted];
  const duplicates = [{ ...inserted, status: "duplicate" }];
  const lean = {
    ...saved,
    items: [{ key: "i0", ...saved }],
    ontologyFingerprint: reconcile.expectedOntologyFingerprint,
  };
  const done = "Remembered knowledge";
  const notApplied = "Remember knowledge · not applied";
  const unknown = "Remember knowledge · outcome unknown";
  for (const [result, label] of [
    [{ items, receipt: { ...lean, state: "conflict", message: conflictMessage } }, notApplied],
    [{ items, receipt: lean }, done],
    [{ items: duplicates, receipt: null }, done],
  ] as const) {
    const output = JSON.stringify(result);
    const wrapped = {
      tool,
      result: { content: [{ type: "text", text: output }], details: result },
    };
    const dispatched = { id: tool.id, args };
    for (const card of [
      recordedCard(name, args, undefined, result),
      recordedCard(name, args, output),
      recordedCard("dispatch_action", dispatched, undefined, wrapped),
      recordedCard("dispatch_action", dispatched, JSON.stringify(wrapped)),
    ]) {
      expect(
        text(await mountCard(card, { expanded: false }), ".chat-tool-disclosure__content"),
      ).toBe(label);
    }
  }
  // Other receipt-contract states and incomplete history, not observed tool returns.
  for (const [details, label] of [
    [{ items, receipt: { ...lean, state: "published" } }, done],
    [
      { items, receipt: { ...lean, state: "accepted" } },
      "Remember knowledge · pending publication",
    ],
    [{ items, receipt: { ...lean, state: "rejected" } }, notApplied],
    [{ items: duplicates }, unknown],
    [{ items, receipt: "unreadable" }, unknown],
    [{ items, receipt: null }, unknown],
  ] as const) {
    expect(catalogToolOperation({ id: name, name, args, details }, "succeeded")?.label).toBe(label);
  }
});

it.each([
  ["knowledge_supersede", supersede, "Supersede claims", "Superseded claims"],
  [
    "knowledge_supersede",
    {
      ...supersede,
      undo: true,
      superseded: [{ id: saved.id, expectedRevision: saved.revision, expectedHash: saved.hash }],
    },
    "Restore superseded claims",
    "Restored superseded claims",
  ],
  [
    "knowledge_reconcile_evidence",
    reconcile,
    "Reconcile knowledge evidence",
    "Reconciled knowledge evidence",
  ],
] as const)("reports the publication receipt for %s: %s", async (name, args, action, done) => {
  const tool = { id: `openclaw:knowledge:${name}`, name, source: "openclaw" };
  const path = "claims/earlier.md";
  const prior = "undo" in args ? args.superseded[0] : recordFence;
  const next = "undo" in args ? { ...saved, revision: 3, hash: "4".repeat(64) } : saved;
  const item = { key: "undo" in args ? "restored" : "superseded", ...next };
  const receipt = name === "knowledge_supersede" ? { ...next, items: [item] } : next;
  const published = {
    ...next,
    ...(name === "knowledge_supersede"
      ? {
          items: [{ ...item, path }],
          targetId: saved.id,
          replacementId: supersede.by.id,
          operation: "undo" in args ? "unsupersede" : "supersede",
          reason: request.reason,
        }
      : {}),
    requestId: request.requestId,
    state: "published",
    path,
    at: "2026-11-24T12:00:00Z",
    message: "Published and available to exact reads.",
    indexed: false,
  };
  // Accepted and rejected are receipt-contract cases, not normal returns of these metadata-only writes.
  const pending = `${action} · pending publication`;
  const notApplied = `${action} · not applied`;
  const unknown = `${action} · outcome unknown`;
  const cases = [
    [receipt, done],
    [published, done],
    [
      { ...receipt, state: "accepted", message: "Accepted for publication; not yet saved." },
      pending,
    ],
    [{ ...receipt, state: "conflict", message: conflictMessage }, notApplied],
    [
      {
        id: prior.id,
        revision: prior.expectedRevision,
        hash: prior.expectedHash,
        state: "rejected",
        message: "Publication rejected.",
      },
      notApplied,
    ],
    [undefined, unknown],
    ["{", unknown],
    [{ ...saved, hash: saved.hash.slice(0, 16) }, unknown],
    [{ ...saved, id: "", revision: 0 }, unknown],
    [{ ...saved, state: "unrecognized" }, unknown],
  ] as const;
  for (const [result, label] of cases) {
    const output = typeof result === "string" ? result : JSON.stringify(result);
    const content = output ? [{ type: "text", text: output }] : [];
    const wrapped = JSON.stringify({ tool, result: { content } });
    for (const card of [
      recordedCard(name, args, output),
      recordedCard("dispatch_action", { id: tool.id, args }, wrapped),
    ]) {
      const inspect = typeof result === "object" && "message" in result;
      const container = await mountCard(card, { expanded: inspect });
      expect.soft(text(container, ".chat-tool-disclosure__content"), output).toBe(label);
      if (inspect) {
        expect(text(container, ".chat-tool-msg-body")).toContain(request.reason);
        expect(text(container, ".chat-tool-msg-body")).toContain(result.message);
      }
    }
  }
});

it("uses the retained dispatcher receipt when the text is omitted, without treating a preview as publication", async () => {
  const name = "knowledge_reconcile_evidence";
  const tool = { id: `openclaw:knowledge:${name}`, name, source: "openclaw" };
  for (const [args, receipt, label] of [
    [reconcile, saved, "Reconciled knowledge evidence"],
    [
      reconcile,
      { ...saved, state: "conflict", message: conflictMessage },
      "Reconcile knowledge evidence · not applied",
    ],
    [
      { ...reconcile, dryRun: true },
      {
        state: "preview",
        id: reconcile.id,
        revision: reconcile.expectedRevision,
        hash: reconcile.expectedHash,
        beforeBytes: 213,
        afterBytes: 187,
        beforeEvidence: 1,
        afterEvidence: 1,
        descriptors: 1,
        representation: "compact",
      },
      "Previewed knowledge evidence changes",
    ],
  ] as const) {
    const inner = { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
    for (const card of [
      recordedCard(name, args, undefined, receipt),
      recordedCard("dispatch_action", { id: tool.id, args }, undefined, { tool, result: inner }),
    ]) {
      expect
        .soft(text(await mountCard(card, { expanded: false }), ".chat-tool-disclosure__content"))
        .toBe(label);
    }
  }
  const missing = recordedCard(name, { ...reconcile, dryRun: true });
  expect
    .soft(text(await mountCard(missing, { expanded: false }), ".chat-tool-disclosure__content"))
    .toBe("Preview knowledge evidence changes · outcome unknown");
});

it.each([
  { code: "await tools.read({ path: 'README.md' })" },
  { command: "set -euo pipefail\npnpm test" },
])("shows the recorded exec action and retains purpose in inspection: %j", async (args) => {
  const card = {
    id: "msg:purpose",
    name: "exec",
    args: { ...args, title: "Check the workspace" },
    live: true,
    outputText: "workspace checked",
  };
  const options = { messageKey: "purpose", expanded: false, runActive: true };
  const container = await mountCard(card, options);
  if (args.code) {
    expect(text(container, ".chat-tool-row__title")).toBe("Check the workspace");
    expect(container.querySelector(".chat-tool-row__cmd")).toBeNull();
  } else {
    expect(text(container, ".chat-tool-row__cmd")).toBe("pnpm test");
    expect(text(container, ".chat-tool-disclosure__content")).not.toContain("Check the workspace");
  }
  expect(container.querySelector(".chat-tool-msg-body")).toBeNull();

  await mountCard({ ...card, completed: true }, { ...options, expanded: true }, container);
  expect(text(container, args.code ? ".chat-tool-row__title" : ".chat-tool-row__cmd")).toBe(
    args.code ? "Check the workspace" : "pnpm test",
  );
  expect(text(container, ".chat-tool-msg-body")).toContain("Check the workspace");
  for (const source of Object.values(args)) {
    expect(text(container, ".chat-tool-msg-body")).toContain(source);
  }
  if (args.code) {
    expect(container.querySelector(".chat-tool-term")).toBeNull();
  }
  expect(text(container, ".chat-tool-msg-body")).toContain("workspace checked");
});

it("does not treat business title arguments as activity descriptions", async () => {
  const container = await mountCard(
    {
      id: "business-title",
      name: "calendar_create",
      args: { title: "Team meeting", command: "create" },
    },
    { messageKey: "business-title", expanded: false },
  );
  expect(container.querySelector(".chat-tool-row__title")).toBeNull();
});

it.each([
  [
    "printf '\n--- recovery ---\n'\ncat recovery.md\n" + "echo example\n".repeat(100),
    "printf ' --- recovery --- ' cat recovery.md",
  ],
  [`printf ${"long argument ".repeat(25)}`, "printf long argument"],
])("keeps command previews bounded without changing the source: %s", async (command, prefix) => {
  const card = { id: "multiline-command", name: "exec", args: { command }, completed: true };
  const container = await mountCard(card, { messageKey: "multiline-command" });
  const preview = text(container, ".chat-tool-row__cmd") ?? "";
  expect(preview).toContain(prefix);
  expect(preview.length).toBeLessThanOrEqual(200);
  expect(container.querySelector(".chat-tool-term__cmd code")?.textContent).toBe(command);
});

it("uses names already available to chat rows without exposing unresolved routing keys", async () => {
  const key = "agent:main:subagent:00000000-0000-4000-8000-000000007ef3";
  const activeRunIds = ["run"];
  const session = { key, kind: "direct" as const, label: "Research", updatedAt: 1, activeRunIds };
  for (const [name, args, known, unresolved] of [
    ["sessions_history", { sessionKey: key }, "Read chat Research", "Read chat"],
    [
      "sessions_send",
      { sessionKey: key },
      "Delivery unconfirmed · Research",
      "Delivery unconfirmed",
    ],
    ["agents_wait", { ids: ["run"] }, "Waited for Research", "Waited for agents"],
  ] as const) {
    for (const [subagentSessions, expected] of [
      [[session], known],
      [[], unresolved],
      [[{ ...session, label: undefined }], unresolved],
    ] as const) {
      const container = await mountCard(
        { id: name, name, completed: true, args },
        { messageKey: name, subagents: { subagentSessions: [...subagentSessions] } },
      );
      expect(text(container, ".chat-tool-disclosure__content")).toBe(expected);
    }
  }
});

it.each([
  [undefined, "Delivery unconfirmed · Release review"],
  [{ status: "other" }, "Delivery unconfirmed · Release review"],
  [{ status: "accepted", targetDisposition: "queued" }, "Message accepted for Release review"],
  [{ status: "queued", runStarted: false }, "Queued message to Release review"],
  [
    { status: "started", retained: { acceptance: "not_accepted" } },
    "Message to Release review deferred",
  ],
  [{ status: "ok", reply: "Received" }, "Sent message to Release review"],
  [{ status: "no_reply" }, "Sent message to Release review"],
] as const)("does not equate a completed send call with delivery: %j", async (receipt, label) => {
  const args = { label: "Release review", message: "Please review the change" };
  const container = await mountCard(
    {
      id: "send",
      name: "mcp__openclaw__sessions_send",
      args,
      completed: true,
      outputText: receipt && JSON.stringify(receipt),
    },
    { expanded: false },
  );
  expect(text(container, ".chat-tool-disclosure__content")).toBe(label);
});

it.each([
  [
    { name: "ToolSearch", args: { query: "select:mcp__openclaw__exec" }, live: true },
    "Selecting tools",
  ],
  [{ name: "sessions_list", args: { limit: 200 }, isError: true }, "List chats"],
  [{ name: "sessions_send", args: { sessionKey: "unknown" }, live: true }, "Sending message"],
  [{ name: "sessions_send", isError: true, details: { status: "ok" } }, "Send message"],
  [
    {
      name: "sessions_send",
      args: { label: "Review" },
      isError: true,
      details: { status: "timeout", error: "agent run timed out", sentBeforeError: true },
    },
    "Sent to Review · reply timed out",
  ],
  [
    {
      name: "sessions_send",
      isError: true,
      outputText: JSON.stringify({
        status: "error",
        error: "Gateway admission is still pending; inspect this run before retrying.",
        sentBeforeError: true,
      }),
    },
    "Delivery unconfirmed",
  ],
  [{ name: "sessions_send", isError: true, details: { status: "timeout" } }, "Send message"],
  [
    {
      name: "tool_call",
      args: { id: "openclaw:core:sessions_send", args: { label: "Review", message: "Check this" } },
      completed: true,
      outputText: JSON.stringify({
        tool: { name: "sessions_send" },
        result: { content: [{ type: "text", text: JSON.stringify({ status: "accepted" }) }] },
      }),
    },
    "Message accepted for Review",
  ],
] as const)(
  "keeps the actual phase and receipt through display normalization: %j",
  async (card, label) => {
    const container = await mountCard(
      { id: "phase", ...card },
      { expanded: false, runActive: true },
    );
    expect(text(container, ".chat-tool-disclosure__content")).toBe(label);
  },
);

it.each([
  ["conversations_send", { details: { status: "sent" } }, "Sent to conversation"],
  ["conversations_send", { outputText: '{"status":"queued"}' }, "Message queued"],
  ["conversations_send", { details: { status: "suppressed" } }, "Message not sent"],
  ["conversations_send", { details: { status: "unknown" } }, "Delivery unconfirmed"],
  ["conversations_send", {}, "Delivery unconfirmed"],
  ["conversations_turn", { live: true, completed: false }, "Sending and waiting for a reply"],
  ["conversations_turn", { details: { status: "replied" } }, "Sent · reply received"],
  ["conversations_turn", { details: { status: "timeout" } }, "Sent · reply timed out"],
  [
    "conversations_turn",
    { details: { status: "sent", error: "No reply correlation" } },
    "Sent to conversation",
  ],
  ["conversations_turn", { details: { status: "queued" } }, "Message queued"],
] as const)(
  "shows the conversation delivery receipt for %s: %j",
  async (name, result, expected) => {
    const container = await mountCard(
      { id: "conversation", name, args: { message: "Hello" }, completed: true, ...result },
      { expanded: false, runActive: true },
    );
    expect(text(container, ".chat-tool-disclosure__content")).toBe(expected);
  },
);

// Captured from createMediaGenerateDuplicateGuardResult for an already queued music task.
const queuedMusic = {
  action: "status",
  duplicateGuard: true,
  async: true,
  active: true,
  existingTask: true,
  status: "queued",
  task: { taskId: "task-active", runId: "run-active" },
  taskKind: "music_generation",
  progressSummary: "Queued music generation",
  sourceId: "music_generate:fixture",
  provider: "fixture",
};
const queuedMusicText =
  "Music generation task task-active is already queued with fixture.\nProgress: Queued music generation.\nDo not call music_generate again for this request. Do not wait, poll, or yield for it: end this turn; the completion arrives as a later turn and sends the finished music here.";
const reviewStart =
  "Review-before-delivery is enabled. Produced candidates remain private until an exact-task delivery decision; do not send them automatically.\nBackground task started for image generation (task-new). Do not call image_generate again for this request.";

it.each([
  ["duplicate guard", "music_generate", queuedMusic, queuedMusicText, "Generate music"],
  ["missing receipt", "image_generate", undefined, undefined, "Generate image"],
  [
    "generic count",
    "music_generate",
    { count: 2 },
    "Generated 2 tracks.\nPrompt: Background task started for music generation (task-from-prompt).",
    "Generate music",
  ],
  [
    "review start",
    "image_generate",
    { async: true, status: "started", taskId: "task-new" },
    reviewStart,
    "Requested image generation",
  ],
  [
    "generated attachment",
    "music_generate",
    { attachments: [{ type: "audio", path: "/fixture/track.mp3" }] },
    "Generated 1 track with fixture/model.",
    "Generated music",
  ],
] as const)(
  "labels the %s in direct and historical media rows",
  async (_case, name, details, outputText, label) => {
    const args = { prompt: "Background task started for image generation (task-from-prompt)." };
    const tool = { id: name, name, source: "openclaw" };
    const content = outputText ? [{ type: "text", text: outputText }] : [];
    const [history] = extractToolCardsCached({
      role: "assistant",
      content: [
        { type: "toolcall", id: "media", name: "tool_call", arguments: { id: name, args } },
        {
          type: "toolresult",
          id: "media",
          name: "tool_call",
          content: jsonResult({ tool, result: { content } }).content,
          details: projectToolResultDetails({ tool, result: { content, details } }, 4_096, {
            name: "tool_call",
          }).details,
        },
      ],
    });
    for (const card of [{ id: name, name, args, details, outputText, completed: true }, history!]) {
      const container = await mountCard(card, { expanded: false });
      expect(text(container, ".chat-tool-row__title")).toBe(label);
    }
  },
);

it.each([
  ["status", "Checked music generation"],
  ["list", "Listed music models"],
])("keeps an explicit media %s action", async (action, label) => {
  const container = await mountCard(
    { id: "music", name: "music_generate", args: { action }, completed: true },
    { expanded: false },
  );
  expect(text(container, ".chat-tool-row__title")).toBe(label);
});

it.each([
  [
    {
      name: "openclaw",
      args: { action: "config_set", path: "agents.defaults.workspace", value: "./work" },
      details: { needsApproval: true },
    },
    "Requested configuration change",
  ],
  [
    {
      name: "openclaw",
      args: { action: "set_default_model", model: "example/model", approved: true },
      outputText: "directive:approved-operation: the host will apply this action after the turn.",
    },
    "Requested default model change",
  ],
  [
    {
      name: "openclaw",
      args: {
        action: "template_install",
        agentId: "research",
        planIntegrity: "reviewed-plan",
        source: { packageName: "@fixture/research", version: "1.0.0" },
      },
      outputText: "directive:template-operation: nothing is installed yet.",
    },
    "Requested template installation",
  ],
  [
    {
      name: "openclaw",
      args: { action: "configure_model_provider" },
      outputText: "directive: the host returns Models sign-in guidance next.",
    },
    "Requested model provider sign-in guidance",
  ],
  [
    {
      name: "plugins",
      args: { action: "reloadAndResume", pluginId: "example" },
      details: { status: "started", async: true, yielded: true },
    },
    "Asked to reload plugins and resume chat",
  ],
  [
    { name: "workboard_board_archive", args: { id: "project", archived: false } },
    "Restored workboard",
  ],
  [{ name: "workboard_board_archive", args: { id: "project" } }, "Archived workboard"],
  [
    {
      name: "tool_call",
      args: {
        id: "openclaw:lobster:lobster",
        args: { action: "resume", token: "checkpoint", cancel: true },
      },
      details: { ok: true, status: "cancelled" },
    },
    "Canceled workflow",
  ],
  [
    {
      name: "lobster",
      args: { action: "resume", token: "checkpoint", approve: false },
      details: { ok: true, status: "cancelled" },
    },
    "Declined workflow approval",
  ],
  [
    {
      name: "lobster",
      args: { action: "resume", token: "checkpoint", approve: true },
      details: { ok: true, status: "ok" },
    },
    "Resumed workflow",
  ],
  [
    {
      name: "workboard_dispatch",
      args: { boardId: "project" },
      details: { promoted: [], reclaimed: [], blocked: [], orchestrated: [], count: 0 },
    },
    "Ran workboard maintenance",
  ],
  [
    { name: "workboard_verify", args: { id: "card", scope: "Review", outcome: "confirmed" } },
    "Verified workboard card",
  ],
  [
    { name: "workboard_verify", args: { id: "card", scope: "Review", outcome: "disputed" } },
    "Recorded workboard card check",
  ],
  [
    { name: "workboard_board_create", args: { id: "project", name: "Renamed board" } },
    "Saved workboard",
  ],
] as const)(
  "reports the recorded platform operation, not an unconfirmed effect: %j",
  async (card, label) => {
    const container = await mountCard(
      { id: "platform", ...card, completed: true },
      { expanded: false },
    );
    expect(text(container, ".chat-tool-disclosure__content")).toBe(label);
  },
);

const stop = (details: object, args: object = {}) => ({
  name: "sessions",
  args: { action: "stop", sessionKey: "agent:main:subagent:worker", runId: "run-secret", ...args },
  details: { ok: true, status: "aborted", abortedRunId: "run-secret", ...details },
});
const cancel = (status: string) => ({
  name: "subagents",
  args: { action: "cancel", runId: "run-secret" },
  details: { found: true, killed: true, targetState: { state: "terminal", task: { status } } },
});

it.each([
  [cancel("cancelled"), "Stopped"],
  [cancel("succeeded"), "Stop subagent"],
  [stop({}), "Stopped"],
  [stop({}, { runId: undefined }), "Stopped"],
  [stop({ status: "settling" }), "Stop subagent"],
  [stop({ abortedRunId: "different-run" }), "Stop subagent"],
  [{ ...stop({}), isError: true }, "Stop subagent"],
  [stop({}, { sessionKey: "agent:main:dashboard:ordinary" }), "Session Settings"],
])(
  "describes cancellation only when its own target receipt confirms it: %j",
  async (card, label) => {
    const { details, ...call } = card;
    for (const receipt of [{ details }, { outputText: JSON.stringify(details) }]) {
      const container = await mountCard(
        { id: "cancel", completed: true, ...call, ...receipt },
        { expanded: false },
      );
      expect(text(container, ".chat-tool-disclosure__content")?.trim()).toBe(label);
    }
  },
);
