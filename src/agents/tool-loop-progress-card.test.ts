import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createPostCompactionLoopGuard } from "./embedded-agent-runner/post-compaction-loop-guard.js";
import {
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";
import { createProgressCardTool } from "./tools/progress-card-tool.js";

vi.mock("./embedded-agent-messaging.js", () => ({ isMessagingToolSendAction: () => false }));
const config = { enabled: true };
const markdown = "Waiting for reviewer results.";
const makeState = (): SessionState => ({ lastActivity: 0, state: "processing", queueDepth: 0 });
type Params = {
  markdown?: string;
  plan?: Array<{ step: string; status: "pending" | "completed" }>;
};
function createFixture() {
  const state = makeState();
  const callGateway = vi.fn();
  const tool = createProgressCardTool({ agentSessionKey: "agent:main:proof", callGateway });
  let revision = 0;
  async function execute(params: Params, runId = "run-1") {
    revision++;
    const toolCallId = "call-" + revision;
    callGateway.mockResolvedValueOnce({
      card:
        params.markdown || params.plan?.length
          ? {
              sessionKey: "agent:main:proof",
              revision,
              updatedAt: revision,
              markdown: params.markdown,
              steps: params.plan,
            }
          : null,
    });
    recordToolCall(state, tool.name, params, toolCallId, config, { runId });
    const result = await tool.execute(toolCallId, params);
    const record = recordToolCallOutcome(state, {
      toolName: tool.name,
      toolParams: params,
      toolCallId,
      result,
      runId,
    });
    expect(record?.resultHash).toBeTypeOf("string");
    return { result, record: record! };
  }
  return { state, execute };
}

describe("progress-card loop outcomes", () => {
  it.each<Params>([
    { markdown },
    {
      plan: [
        { step: "Review", status: "pending" },
        { step: "Verify", status: "pending" },
      ],
    },
    {},
  ])(
    "blocks repeated real receipts without changing revision acknowledgments: %j",
    async (params) => {
      const { state, execute } = createFixture();
      const hashes = new Set();
      for (let index = 0; index < 20; index++) {
        expect(
          detectToolCallLoop(state, "progress_card", params, config, { runId: "run-1" }),
        ).not.toMatchObject({ level: "critical" });
        const { result, record } = await execute(params);
        expect(result.details).toMatchObject({
          revision: Object.keys(params).length ? index + 1 : null,
        });
        hashes.add(record.resultHash);
      }
      expect(hashes.size).toBe(1);
      expect(
        detectToolCallLoop(state, "progress_card", params, config, { runId: "run-1" }),
      ).toMatchObject({ stuck: true, level: "critical", count: 20 });
      expect(
        detectToolCallLoop(state, "progress_card", params, config, { runId: "run-2" }),
      ).toEqual({ stuck: false });
      expect(
        detectToolCallLoop(state, "progress_card", params, { enabled: false }, { runId: "run-1" }),
      ).toEqual({ stuck: false });
    },
  );
  it("keeps markdown and plan changes meaningful even when counts match", async () => {
    const { state, execute } = createFixture();
    const hashes = new Set();
    const inputs: Params[] = [
      { markdown },
      { markdown: "Review completed; verification running." },
      { plan: [{ step: "Review", status: "pending" }] },
      { plan: [{ step: "Verify", status: "pending" }] },
      { plan: [{ step: "Verify", status: "completed" }] },
      {},
    ];
    for (const params of inputs) {
      expect(
        detectToolCallLoop(state, "progress_card", params, config, { runId: "run-1" }),
      ).toEqual({ stuck: false });
      const { record } = await execute(params);
      hashes.add([record.argsHash, record.resultHash].join(":"));
    }
    expect(hashes.size).toBe(6);
  });
  it("feeds stable receipt outcomes to the armed post-compaction guard", async () => {
    const { execute } = createFixture();
    const guard = createPostCompactionLoopGuard();
    guard.armPostCompaction();
    for (let index = 0; index < 3; index++) {
      const { record } = await execute({ markdown });
      expect(
        guard.observe({
          toolName: record.toolName,
          argsHash: record.argsHash,
          resultHash: record.resultHash!,
        }).shouldAbort,
      ).toBe(index === 2);
    }
  });
  it.each(["read", "error"])("does not normalize a real receipt used as %s", async (kind) => {
    const { execute } = createFixture();
    const state = makeState();
    for (let index = 0; index < 2; index++) {
      const { result } = await execute({ markdown });
      recordToolCallOutcome(state, {
        toolName: kind === "read" ? "read" : "progress_card",
        toolParams: { markdown },
        result: kind === "error" ? Object.assign(result, { isError: true }) : result,
      });
    }
    expect(new Set(state.toolCallHistory?.map((record) => record.resultHash)).size).toBe(2);
  });
  it("keeps semantic outcomes private and independent of receipt wording", async () => {
    const { execute } = createFixture();
    const state = makeState();
    for (let index = 0; index < 2; index++) {
      const { result } = await execute({ markdown });
      expect(Object.keys(result).toSorted()).toEqual(["content", "details"]);
      result.content = [{ type: "text", text: "New receipt wording " + index }];
      recordToolCallOutcome(state, { toolName: "progress_card", toolParams: { markdown }, result });
    }
    expect(new Set(state.toolCallHistory?.map((record) => record.resultHash)).size).toBe(1);
  });
  it("does not erase arbitrary revisions or errors from other outcomes", () => {
    for (const [toolName, isError] of [
      ["read", false],
      ["progress_card", true],
      ["progress_card", false],
    ] as const) {
      const state = makeState();
      for (let revision = 1; revision <= 2; revision++) {
        recordToolCallOutcome(state, {
          toolName,
          toolParams: { markdown },
          result: {
            isError,
            details: { revision, steps: null },
            content: [{ type: "text", text: "Read failed at revision " + revision }],
          },
        });
      }
      expect(new Set(state.toolCallHistory?.map((record) => record.resultHash)).size).toBe(2);
    }
  });
});
