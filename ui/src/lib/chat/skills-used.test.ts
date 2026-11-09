import { expect, it } from "vitest";
import { createNestedToolActivity } from "../../../../src/sessions/nested-tool-activity.js";
import { conversationSkillsUsed } from "./skills-used.ts";

const call = (id: string, name: string, runId = "run-1") => ({
  role: "assistant",
  runId,
  content: [{ type: "toolCall", id, name: "skills_read", arguments: { name } }],
});
const result = (id: string, isError = false, runId = "run-1") => ({
  role: "toolResult",
  runId,
  toolCallId: id,
  toolName: "skills_read",
  content: [{ type: "text", text: "result" }],
  isError,
});

it("counts successful loads once across history/live overlap, preserving repeated loads and run identity", () => {
  const history = [
    call("one", "review"),
    result("one"),
    call("failed", "missing"),
    result("failed", true),
    call("pending", "not-loaded"),
  ];
  const live = [
    call("one", "review"),
    result("one"),
    call("one", "release", "run-2"),
    result("one", false, "run-2"),
    call("again", "review"),
    result("again"),
    { ...call("one", "review"), __openclawToolStreamLive: true },
  ];
  expect(conversationSkillsUsed(history, live)).toEqual([
    { name: "review", loads: 2 },
    { name: "release", loads: 1 },
  ]);
  expect(conversationSkillsUsed([], [])).toEqual([]);
  expect(conversationSkillsUsed([call("one", "another-session"), result("one")], [])).toEqual([
    { name: "another-session", loads: 1 },
  ]);
});

it("merges a complete session summary with a paginated tail and live replay without losing older loads", () => {
  const recorded = [
    { id: '["run-1","one"]', name: "review" },
    { id: '["old-run","old"]', name: "older-history" },
  ];
  expect(
    conversationSkillsUsed(
      [],
      [
        { ...call("one", "review"), __openclawToolStreamLive: true },
        call("new", "release"),
        result("new"),
      ],
      recorded,
    ),
  ).toEqual([
    { name: "review", loads: 1 },
    { name: "older-history", loads: 1 },
    { name: "release", loads: 1 },
  ]);
  expect(conversationSkillsUsed([], [], [])).toEqual([]);
});

it("does not infer skill use from user content or an exec program mentioning skills.read", () => {
  expect(
    conversationSkillsUsed(
      [
        { ...call("fake", "not-used"), role: "user" },
        result("fake"),
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "exec",
              name: "exec",
              arguments: { code: 'await skills.read("not-executed")' },
            },
          ],
        },
      ],
      [],
    ),
  ).toEqual([]);
});

it.each(["id", "tool_call_id", "toolCallId", "tool_use_id", "toolUseId"])(
  "correlates native and block skill results using the %s identity alias",
  (field) => {
    const invocation = call("aliased", "review");
    const output = {
      [field]: "aliased",
      isError: false,
      content: [{ type: "text", text: "Instructions" }],
    };
    expect(
      conversationSkillsUsed([invocation, { role: "toolResult", runId: "run-1", ...output }], []),
    ).toEqual([{ name: "review", loads: 1 }]);
    expect(
      conversationSkillsUsed(
        [
          invocation,
          { role: "assistant", runId: "run-1", content: [{ type: "tool_result", ...output }] },
        ],
        [],
      ),
    ).toEqual([{ name: "review", loads: 1 }]);
  },
);

it.each([
  { label: "classified failure", text: "Unavailable", flag: false, outcome: "failed", used: false },
  {
    label: "unknown classified outcome",
    text: "Instructions",
    flag: false,
    outcome: "unknown",
    used: false,
  },
  {
    label: "unflagged error JSON",
    text: '{"status":"error","error":"Unavailable"}',
    flag: undefined,
    outcome: undefined,
    used: false,
  },
  {
    label: "unflagged failure text",
    text: "Tool not found.",
    flag: undefined,
    outcome: undefined,
    used: false,
  },
  {
    label: "successful SKILL.md error example",
    text: '{"error":"Example error in the skill instructions"}',
    flag: false,
    outcome: undefined,
    used: true,
  },
])(
  "applies canonical failure semantics to native and block loads: $label",
  ({ text, flag, outcome, used }) => {
    const invocation = call("checked", "error-examples");
    const output = {
      toolCallId: "checked",
      content: [{ type: "text", text }],
      ...(flag === undefined ? {} : { isError: flag }),
      ...(outcome
        ? { __openclaw: { toolOutput: { source: "execution", modelInput: "unverified", outcome } } }
        : {}),
    };
    const expected = used ? [{ name: "error-examples", loads: 1 }] : [];
    expect(
      conversationSkillsUsed(
        [invocation, { role: "toolResult", runId: "run-1", toolName: "skills_read", ...output }],
        [],
      ),
    ).toEqual(expected);
    expect(
      conversationSkillsUsed(
        [
          invocation,
          {
            role: "assistant",
            runId: "run-1",
            content: [{ type: "tool_result", name: "skills_read", ...output }],
          },
        ],
        [],
      ),
    ).toEqual(expected);
  },
);

it.each(["failed", "unknown", undefined])(
  "honors nested load classification %s without inferring failure from successful instructions",
  (outcome) => {
    const nested = createNestedToolActivity({
      runId: "nested-run",
      scopeId: "scope",
      afterEntryId: null,
      startOrder: 0,
      toolCallId: "nested-load",
      toolName: "skills_read",
      input: { name: "error-examples" },
      result: { content: [{ type: "text", text: '{"error":"An example in SKILL.md"}' }] },
      isError: false,
      startedAt: 1,
      timestamp: 2,
    });
    const message = {
      ...nested,
      ...(outcome
        ? { __openclaw: { toolOutput: { source: "execution", modelInput: "unverified", outcome } } }
        : {}),
    };
    expect(conversationSkillsUsed([message], [])).toEqual(
      outcome ? [] : [{ name: "error-examples", loads: 1 }],
    );
  },
);
