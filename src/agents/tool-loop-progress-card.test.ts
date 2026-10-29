import { afterEach, expect, it, vi } from "vitest";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createPostCompactionLoopGuard } from "./embedded-agent-runner/post-compaction-loop-guard.js";
import {
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";
import { jsonResult } from "./tools/common.js";
import * as gateway from "./tools/in-process-gateway.js";
import { createProgressCardTool } from "./tools/progress-card-tool.js";

afterEach(() => vi.restoreAllMocks());

vi.mock("./embedded-agent-messaging.js", () => ({ isMessagingToolSendAction: () => false }));
const initialMarkdown = "Waiting for reviewer results.";
const sessionKey = "agent:main:proof";
const makeState = (): SessionState => ({ lastActivity: 0, state: "processing", queueDepth: 0 });
type Params = {
  markdown?: string;
  plan?: Array<{ step: string; status: "pending" | "completed" }>;
};
function createFixture() {
  const state = makeState();
  const callGateway = vi.spyOn(gateway, "callInProcessGatewayTool");
  const tool = createProgressCardTool({ agentSessionKey: sessionKey });
  const { name: toolName } = tool;
  let revision = 0;
  async function execute(toolParams: Params, runId = "run-1") {
    const { markdown, plan } = toolParams;
    revision++;
    const toolCallId = "call-" + revision;
    callGateway.mockResolvedValueOnce({
      card:
        markdown || plan?.length
          ? { sessionKey, revision, updatedAt: revision, markdown, steps: plan }
          : null,
    });
    recordToolCall(state, toolName, toolParams, toolCallId, { runId });
    const result = await tool.execute(toolCallId, toolParams);
    const record = recordToolCallOutcome(state, {
      toolName,
      toolParams,
      toolCallId,
      result,
      runId,
    });
    expect(record?.resultHash).toBeTypeOf("string");
    return { result, record: { ...record!, resultHash: record!.resultHash! } };
  }
  return { state, execute };
}

const plan = (step: string, status: "pending" | "completed" = "pending") => [{ step, status }];

it.each<Params>([{ markdown: initialMarkdown, plan: [...plan("Review"), ...plan("Verify")] }, {}])(
  "blocks repeated real receipts without changing revision acknowledgments: %j",
  async (params) => {
    const { state, execute } = createFixture();
    const hashes = new Set();
    const detect = (runId = "run-1") =>
      detectToolCallLoop(state, "progress_card", params, { runId });
    for (let index = 0; index < 20; index++) {
      expect(detect()).not.toMatchObject({ level: "critical" });
      const { result, record } = await execute(params);
      expect(result.details).toMatchObject({
        revision: Object.keys(params).length ? index + 1 : null,
      });
      hashes.add(record.resultHash);
    }
    expect(hashes.size).toBe(1);
    expect(detect()).toMatchObject({ stuck: true, level: "critical", count: 20 });
    expect(detect("run-2")).toEqual({ stuck: false });
  },
);
it("keeps markdown and plan changes meaningful even when counts match", async () => {
  const { state, execute } = createFixture();
  const hashes = new Set();
  const inputs: Params[] = [
    { markdown: initialMarkdown },
    { markdown: "Review completed; verification running." },
    { plan: plan("Review") },
    { plan: plan("Verify") },
    { plan: plan("Verify", "completed") },
    {},
  ];
  for (const params of inputs) {
    expect(detectToolCallLoop(state, "progress_card", params, { runId: "run-1" })).toEqual({
      stuck: false,
    });
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
    const { record } = await execute({ markdown: initialMarkdown });
    expect(guard.observe(record).shouldAbort).toBe(index === 2);
  }
});
it.each(["read", "error", "rewritten", "unmarked"] as const)(
  "normalizes only private successful progress-card outcomes: %s",
  async (kind) => {
    const { execute } = createFixture();
    const state = makeState();
    for (let revision = 1; revision <= 2; revision++) {
      const result =
        kind === "unmarked"
          ? jsonResult({ revision, steps: null })
          : (await execute({ markdown: initialMarkdown })).result;
      if (kind === "rewritten") {
        result.content = [{ type: "text", text: "New receipt wording " + revision }];
      }
      recordToolCallOutcome(state, {
        toolName: kind === "read" ? "read" : "progress_card",
        toolParams: { markdown: initialMarkdown },
        result: kind === "error" ? Object.assign(result, { isError: true }) : result,
      });
    }
    expect(new Set(state.toolCallHistory?.map((record) => record.resultHash)).size).toBe(
      kind === "rewritten" ? 1 : 2,
    );
  },
);
