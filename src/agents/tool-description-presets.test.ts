import { describe, expect, it } from "vitest";
import {
  describeAskUserTool,
  describeSecretsTool,
  describeSessionsHistoryTool,
  describeSessionsListTool,
  describeSessionsSearchTool,
  describeSessionsSendTool,
  describeSessionsSpawnTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "./tool-description-presets.js";

describe("ask_user tool guidance", () => {
  it("keeps native-control requirements visible to the model", () => {
    const description = describeAskUserTool();

    expect(description).toContain("exactly one question per call");
    expect(description).toContain("native controls");
    expect(description).toContain("Put every selectable choice in `options`");
    expect(description).toContain("Use `multiSelect` only");
  });
});

describe("secrets tool guidance", () => {
  it("distinguishes config references from egress permission without offering plaintext", () => {
    const description = describeSecretsTool();
    expect(description).toContain("`list` metadata first");
    expect(description).toContain("human masked entry");
    expect(description).toContain("store SecretRef for supported config fields");
    expect(description).toContain("enabled proxy + exact allowedHosts required");
    expect(description).toContain("no hosts blocks egress, not config refs");
    expect(description).toContain("No plaintext fallback");
    expect(description).toContain("auto-injected opaque env sentinel under stored name");
    expect(description).toContain("No secret templates; never override/print that variable");
    expect(description).toContain("Native shell/sandbox/node: no protected injection");
    expect(description).toContain("late saves need next turn");
    expect(description).toContain("Operator-set env entries are readable and managed separately");
    expect(description).toContain("no_answer means no credential was supplied");
  });
});

const SESSION_LINK_BASE = "http://127.0.0.1:18789/control";
const SESSION_LINK_LINE =
  "When pointing the user at a session, cite its Control UI URL: main session -> `http://127.0.0.1:18789/control/chat/<agentId>`; any other display session key -> `http://127.0.0.1:18789/control/chat/<agentId>/~key/` + key minus `agent:<agentId>:`, with `:` replaced by `/`.";
const SESSION_DESCRIPTIONS = [
  {
    tool: "sessions_list",
    describe: describeSessionsListTool,
    original:
      "List visible session metadata and groups; filter ownerId/creatorId, projectId/workspaceDir, group/pinned, kind/agent/activity/archive. relationship=owned|created|involving selects the authenticated requesting user's sessions, not the agent's owner. Metadata-only by default. limit defaults to 100; larger requests stay valid but limitApplied never exceeds 200. count is this page, not an inventory total. Continue with nextOffset and identical filters while hasMore; truncationReason names a scan/byte budget. Pages are live: deduplicate by agentId/key/sessionId or restart for a fresh inventory. archived=all includes active and archived rows. Preview recent messages inline via includeLastMessage/messageLimit; includeDerivedTitles adds derived titles. enrichmentOmitted means previews exceeded the byte budget; read history separately. Use before history/send target selection.",
  },
  {
    tool: "sessions_history",
    describe: describeSessionsHistoryTool,
    original:
      "Read sanitized visible-session history. Before reply/debug/resume. Use messageId for anchored history; sessionId selects its transcript and requires messageId. Omit both for the latest tail. offset pages unanchored history and is ignored with messageId. limit bounds either mode. Include tool messages with includeTools. pendingInputs are accepted inputs outside model history; page with pendingBefore=nextBefore. Cancelled/interrupted inputs never replay automatically. Lower limit for richer pending previews.",
  },
  {
    tool: "sessions_search",
    describe: describeSessionsSearchTool,
    original: "Search visible past sessions for matching user and assistant text.",
  },
] as const;

describe("session tool link guidance", () => {
  it.each(SESSION_DESCRIPTIONS)("keeps $tool bytes unchanged without a link base", (entry) => {
    expect(entry.describe()).toBe(entry.original);
  });

  it.each(SESSION_DESCRIPTIONS)("appends the shared link rule to $tool", (entry) => {
    expect(entry.describe({ sessionLinkBase: SESSION_LINK_BASE })).toBe(
      `${entry.original} ${SESSION_LINK_LINE}`,
    );
  });
});

describe("sessions_send tool description", () => {
  it("distinguishes local context selection from exact external addressing", () => {
    expect(SESSIONS_SEND_TOOL_DISPLAY_SUMMARY).toContain("same-Gateway");
    expect(describeSessionsSendTool()).toContain("on this Gateway");
    expect(describeSessionsSendTool()).toContain("not an external address");
    expect(describeSessionsSendTool()).not.toContain("conversations_");
    expect(describeSessionsSendTool()).toContain("reply may still announce");
    expect(describeSessionsSendTool()).toContain('`targetDisposition: "queued"` or `"steered"`');
    expect(describeSessionsSendTool()).toContain("neither proves target completion");
  });
});

describe("sessions_spawn delegation guidance", () => {
  it("bounds API investigation handoffs without delegating quick lookups", () => {
    const description = describeSessionsSpawnTool();
    expect(description).toContain(
      "Default to a hidden subagent for internal QA, research, coding, review, tests, and parallel work supporting the current task. This includes substantial, bounded API/service investigations that can be handed off with the needed context and capabilities. Omit `visible` or set it false, and report results through the parent.",
    );
    expect(description).toContain(
      "A PR/report, long runtime, or isolated worktree alone does not justify a sidebar session. A request for a subagent does not request a separate session. No spawn for quick lookup/single read.",
    );
    expect(description).not.toContain("trial-and-error");
    expect(description).not.toContain("auth probing");
  });
});
