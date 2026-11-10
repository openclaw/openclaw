import { expect, it } from "vitest";
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

it("keeps ask_user native-control requirements visible to the model", () => {
  const description = describeAskUserTool();

  expect(description).toContain("exactly one question per call");
  expect(description).toContain("native controls");
  expect(description).toContain("Put every selectable choice in `options`");
  expect(description).toContain("Use `multiSelect` only");
});

it("distinguishes secret config references from egress permission without offering plaintext", () => {
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

const SESSION_LINK_BASE = "http://127.0.0.1:18789/control";
const SESSION_LINK_LINE =
  "When pointing the user at a session, cite its Control UI URL: main session -> `http://127.0.0.1:18789/control/chat/<agentId>`; any other display session key -> `http://127.0.0.1:18789/control/chat/<agentId>/~key/` + key minus `agent:<agentId>:`, with `:` replaced by `/`.";
it.each([describeSessionsListTool, describeSessionsHistoryTool, describeSessionsSearchTool])(
  "only appends the shared link rule to %s when configured",
  (describe) => {
    const original = describe();
    expect(original).not.toContain("When pointing the user at a session");
    expect(describe({ sessionLinkBase: SESSION_LINK_BASE })).toBe(
      `${original} ${SESSION_LINK_LINE}`,
    );
  },
);

it("distinguishes sessions_send local context selection from exact external addressing", () => {
  const description = describeSessionsSendTool();
  expect(SESSIONS_SEND_TOOL_DISPLAY_SUMMARY).toContain("same-Gateway");

  expect(description).toContain("on this Gateway");
  expect(description).toContain("not an external address");
  expect(description).toContain("When a new turn starts, its reply reaches you once");
  expect(description).toContain("Continue with another sessions_send");
  expect(description).toContain("post to channels with message");
  expect(description).toContain('`targetDisposition: "queued"` or `"steered"`');
  expect(description).toContain("neither proves target completion");
  expect(description).toContain("Ordinary peer sends start a separate turn.");
  expect(description).toContain(
    "A zero-wait send to your own busy child or an eligible run-scoped target may use its active input queue.",
  );
  expect(description).toContain("An idle recipient or a default self-send starts a new turn");
  expect(description).toContain(
    "mode:followup always starts a separate turn and preserves its independent reply",
  );
  expect(description).not.toContain("conversations_");
});

it("bounds sessions_spawn API investigation handoffs without delegating quick lookups", () => {
  const description = describeSessionsSpawnTool();

  expect(description).toContain(
    "Execute work directly by default. Delegate a bounded, independent task only when parallel execution or an independent review provides a concrete benefit. Keep dependent steps with the same owner. Once delegation is appropriate, use a hidden subagent unless the user needs to revisit or steer deliberately supervised child work. This includes substantial, bounded API/service investigations that can be handed off with the needed context and capabilities. For hidden subagents, omit `visible` or set it false, and report results through the parent.",
  );
  expect(description).toContain(
    "A PR/report, long runtime, or isolated worktree alone does not justify a sidebar session. A request for a subagent does not request a separate session. No spawn for quick lookup/single read.",
  );
  expect(description).not.toContain("trial-and-error");
  expect(description).not.toContain("auth probing");
});
