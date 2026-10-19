import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, onTestFailed, test } from "vitest";
import {
  createQaBusState,
  startQaBusServer,
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { type CapturedSpan, startLocalOtlpReceiver } from "./otel-test-support.js";

const CODE_MODE_RECONCILIATION_NEEDLE =
  "The previous Code Mode mutation may have partially applied.";

async function startOtlpReceiver(disallowedBodyNeedles: string[] = []) {
  const receiver = startLocalOtlpReceiver(disallowedBodyNeedles);
  const port = await receiver.listen();
  return { ...receiver, baseUrl: `http://127.0.0.1:${port}` };
}

async function settleCleanup(
  cleanups: Record<string, () => Promise<void>>,
  pending: Set<string>,
): Promise<void> {
  const results = await Promise.allSettled(
    Object.entries(cleanups).map(async ([name, cleanup]) => {
      pending.add(name);
      try {
        await cleanup();
      } finally {
        pending.delete(name);
      }
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "diagnostics-otel gateway cleanup failed");
  }
}

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 30_000,
  timeoutContext?: () => unknown,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await sleep(100);
  }
  const context = await timeoutContext?.();
  throw new Error(
    `timed out waiting for QA runtime evidence${
      context === undefined ? "" : `: ${JSON.stringify(context)}`
    }`,
  );
}

function indexSpansById(spans: CapturedSpan[]): Map<string, CapturedSpan> {
  return new Map(spans.flatMap((span) => (span.spanId ? ([[span.spanId, span]] as const) : [])));
}

function expectResolvedParent(
  span: CapturedSpan,
  spansById: ReadonlyMap<string, CapturedSpan>,
): CapturedSpan {
  expect(span.parentSpanId).toBeTruthy();
  const parent = span.parentSpanId ? spansById.get(span.parentSpanId) : undefined;
  expect(parent).toBeDefined();
  return parent!;
}

function expectTraceParents(spans: CapturedSpan[], tool: CapturedSpan, counts?: number[]) {
  const spansById = indexSpansById(spans);
  const terminal = spans.find(
    (span) =>
      span.name === "openclaw.message.processed" &&
      span.attributes["openclaw.channel"] === "qa-channel" &&
      span.attributes["openclaw.outcome"] === "completed",
  );
  expect(terminal).toBeDefined();
  expect(terminal?.parentSpanId).toBeFalsy();
  const levels = ["openclaw.harness.run", "openclaw.run", "openclaw.model.call"];
  for (const [index, name] of levels.entries()) {
    const children = spans.filter((span) => span.name === name);
    if (counts) {
      expect(children).toHaveLength(counts[index]!);
    } else {
      expect(children.length).toBeGreaterThanOrEqual(1);
    }
    for (const child of children) {
      const parent = expectResolvedParent(child, spansById);
      if (index === 0) {
        expect(parent).toBe(terminal);
      } else {
        expect(parent.name).toBe(levels[index - 1]);
      }
    }
  }
  expect(expectResolvedParent(tool, spansById).name).toBe("openclaw.run");
}

describe("diagnostics-otel gateway runtime", () => {
  test("exports linked success and failed-read recovery spans from a real qa-channel run", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../../..");
    const state = createQaBusState();
    const transport = {
      requiredPluginIds: ["qa-channel"],
      createGatewayConfig: ({ baseUrl }: { baseUrl: string }) => ({
        channels: {
          "qa-channel": {
            enabled: true,
            baseUrl,
            botUserId: "openclaw",
            botDisplayName: "OpenClaw QA",
            allowFrom: ["*"],
            pollTimeoutMs: 250,
          },
        },
        messages: {
          visibleReplies: "automatic" as const,
          groupChat: {
            mentionPatterns: ["\\b@?openclaw\\b"],
            visibleReplies: "automatic" as const,
          },
        },
      }),
    };
    let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
    let receiver: Awaited<ReturnType<typeof startOtlpReceiver>> | undefined;
    let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
    const gatewayOwner = createQaGatewayChild();
    const startedAt = performance.now();
    let phase = "fixture setup";
    let cleanupStartedAfterMs: number | undefined;
    const pendingCleanupOwners = new Set<string>();
    let gatewayLogs: (() => string) | undefined;
    onTestFailed(() => {
      process.stderr.write(
        JSON.stringify({
          phase,
          elapsedMs: Math.round(performance.now() - startedAt),
          cleanupStartedAfterMs,
          pendingCleanupOwners: [...pendingCleanupOwners],
          capturedSpanCount: receiver?.capturedSpans.length,
        }) + "\n",
      );
      if (gatewayLogs) {
        process.stderr.write(gatewayLogs().slice(-12_000) + "\n");
      }
    });

    try {
      bus = await startQaBusServer({ state });
      const activeReceiver = await startOtlpReceiver(["qa-plugin-usage-secret-sentinel"]);
      receiver = activeReceiver;
      mock = await startQaMockOpenAiServer();
      phase = "gateway startup";
      const gateway = await gatewayOwner.start({
        repoRoot,
        useRepoCli: true,
        providerBaseUrl: `${mock.baseUrl}/v1`,
        providerMode: "mock-openai",
        transport,
        transportBaseUrl: bus.baseUrl,
        enabledPluginIds: ["diagnostics-otel", "llm-task"],
        controlUiEnabled: false,
        mutateConfig: (cfg) => ({
          ...cfg,
          session: {
            ...cfg.session,
            dmScope: "per-peer",
          },
          tools: {
            ...cfg.tools,
            alsoAllow: [...(cfg.tools?.alsoAllow ?? []), "llm-task"],
            codeMode: {
              ...(typeof cfg.tools?.codeMode === "object" ? cfg.tools.codeMode : {}),
              enabled: true,
            },
          },
          diagnostics: {
            enabled: true,
            otel: {
              enabled: true,
              endpoint: activeReceiver.baseUrl,
              protocol: "http/protobuf",
              traces: true,
              metrics: false,
              logs: false,
              sampleRate: 1,
              flushIntervalMs: 1000,
              captureContent: false,
            },
          },
        }),
      });
      gatewayLogs = gateway.logs;
      const conversation = { id: "qa-operator", kind: "direct" as const };
      const send = async (
        text: string,
        expectedText: string,
        targetConversation = conversation,
      ) => {
        phase = `send ${expectedText}`;
        const cursor = state.getSnapshot().messages.length;
        state.addInboundMessage({
          conversation: targetConversation,
          senderId: "qa-user",
          senderName: "QA User",
          text,
        });
        return await waitFor(
          () =>
            state
              .getSnapshot()
              .messages.slice(cursor)
              .find(
                (message) =>
                  message.direction === "outbound" &&
                  message.conversation.id === targetConversation.id &&
                  message.text.includes(expectedText),
              ),
          30_000,
          () => ({
            expectedText,
            targetConversation,
            traces: activeReceiver.recentTraceSummary(),
            gatewayLogs: gateway.logs().slice(-12_000),
          }),
        );
      };

      const successful = await send(
        "Tool progress QA check: use the read tool exactly once on `QA_KICKOFF_TASK.md` before answering. After that read completes, reply with only this exact marker and no other text: `OTEL-GATEWAY-SUCCESS-OK`.",
        "OTEL-GATEWAY-SUCCESS-OK",
      );
      expect(successful.direction).toBe("outbound");
      expect(successful.text).toContain("OTEL-GATEWAY-SUCCESS-OK");

      const requestCursor = (await fetch(`${mock.baseUrl}/debug/request-cursor`).then((response) =>
        response.json(),
      )) as { cursor: number };
      const recovered = await send(
        "Failed tool terminal recovery QA check: read the missing workspace file, then respond with exact marker: `QA-FAILED-TOOL-FINALIZED-OK`.",
        "QA-FAILED-TOOL-FINALIZED-OK",
      );
      expect(recovered.direction).toBe("outbound");
      expect(recovered.text).toContain("The requested file could not be read: ENOENT.");
      expect(recovered.text).toContain("QA-FAILED-TOOL-FINALIZED-OK");

      phase = "failed-read provider transcript";
      const scenarioRequests = (await fetch(
        `${mock.baseUrl}/debug/requests?after=${requestCursor.cursor}`,
      ).then((response) => response.json())) as Array<{
        allInputText?: string;
        body?: { input?: Array<Record<string, unknown>>; tools?: Array<{ name?: string }> };
        plannedToolCallId?: string;
        plannedToolName?: string;
        plannedWireToolName?: string;
        toolOutputCallId?: string;
        toolOutput?: string;
      }>;
      const readPlans = scenarioRequests.filter((request) => request.plannedToolName === "read");
      expect(readPlans).toHaveLength(1);
      expect(readPlans[0]?.plannedToolCallId).toBeTruthy();
      expect(readPlans[0]?.plannedWireToolName).toBe("exec");
      expect(scenarioRequests).toHaveLength(2);
      const continuation = scenarioRequests[1]!;
      expect(continuation.toolOutputCallId).toBe(readPlans[0]?.plannedToolCallId);
      expect(continuation.toolOutput).toMatch(/ENOENT|no such file/i);
      expect(continuation.allInputText).not.toContain(CODE_MODE_RECONCILIATION_NEEDLE);
      expect(continuation.body?.tools?.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["exec", "wait"]),
      );
      const continuationInput = continuation.body?.input ?? [];
      for (const type of ["function_call", "function_call_output"]) {
        expect(
          continuationInput.filter(
            (item) => item.type === type && item.call_id === readPlans[0]?.plannedToolCallId,
          ),
        ).toHaveLength(1);
      }
      phase = "failed-read spans";
      const failureEvidence = await waitFor(
        () => {
          const toolError = activeReceiver.capturedSpans.find(
            (span) =>
              span.name === "openclaw.tool.execution" &&
              span.statusCode === 2 &&
              span.attributes["openclaw.toolName"] === "read" &&
              Boolean(span.attributes["openclaw.errorCategory"]),
          );
          if (!toolError?.traceId) {
            return undefined;
          }
          const sameTrace = activeReceiver.capturedSpans.filter(
            (span) => span.traceId === toolError.traceId,
          );
          const runs = sameTrace.filter((span) => span.name === "openclaw.run");
          const harnesses = sameTrace.filter((span) => span.name === "openclaw.harness.run");
          const modelCalls = sameTrace.filter((span) => span.name === "openclaw.model.call");
          // QA-channel inbound replies use the channel-owned direct callback, not
          // deliver-core; the outbound bus receipt above is the delivery proof.
          const terminal = sameTrace.find(
            (span) =>
              span.name === "openclaw.message.processed" &&
              span.attributes["openclaw.channel"] === "qa-channel" &&
              span.attributes["openclaw.outcome"] === "completed",
          );
          return runs.length >= 1 && harnesses.length >= 1 && modelCalls.length >= 2 && terminal
            ? { harnesses, modelCalls, runs, sameTrace, terminal, toolError }
            : undefined;
        },
        45_000,
        () => ({
          requests: activeReceiver.capturedRequests.slice(-8),
          traces: activeReceiver.recentTraceSummary(),
        }),
      );

      phase = "failed-read span assertions";
      expectTraceParents(failureEvidence.sameTrace, failureEvidence.toolError, [1, 1, 2]);

      const successEvidence = activeReceiver.capturedSpans.find(
        (span) =>
          span.name === "openclaw.tool.execution" &&
          span.statusCode !== 2 &&
          span.attributes["openclaw.toolName"] === "read" &&
          span.traceId !== failureEvidence.toolError.traceId,
      );
      expect(successEvidence).toBeTruthy();
      const successTrace = activeReceiver.capturedSpans.filter(
        (span) => span.traceId === successEvidence?.traceId,
      );
      expectTraceParents(successTrace, successEvidence!);

      const llmTaskConversation = { id: "qa-plugin-usage", kind: "direct" as const };
      const llmTaskSpanCursor = activeReceiver.capturedSpans.length;
      const llmTaskCursor = (await fetch(`${mock.baseUrl}/debug/request-cursor`).then((response) =>
        response.json(),
      )) as { cursor: number };
      const llmTaskReply = await send(
        "tool search qa check target=llm-task. Call exactly that tool once, then reply with only this exact marker: `OTEL-PLUGIN-USAGE-OK`.",
        "OTEL-PLUGIN-USAGE-OK",
        llmTaskConversation,
      );
      expect(llmTaskReply.text).toContain("OTEL-PLUGIN-USAGE-OK");

      phase = "plugin provider transcript";
      const llmTaskRequests = (await fetch(
        `${mock.baseUrl}/debug/requests?after=${llmTaskCursor.cursor}`,
      ).then((response) => response.json())) as Array<{
        allInputText?: string;
        plannedToolName?: string;
      }>;
      expect(
        llmTaskRequests.filter((request) => request.plannedToolName === "llm-task"),
      ).toHaveLength(1);
      expect(
        llmTaskRequests.some((request) =>
          String(request.allInputText).includes("You are a JSON-only function."),
        ),
      ).toBe(true);

      phase = "plugin usage spans";
      const llmTaskUsage = await waitFor(
        () =>
          activeReceiver.capturedSpans.find(
            (span) =>
              span.name === "openclaw.model.usage" &&
              span.attributes["openclaw.plugin"] === "llm-task",
          ),
        45_000,
        () => activeReceiver.capturedSpans,
      );
      phase = "plugin usage assertions";
      expect(llmTaskUsage.attributes).toMatchObject({
        "openclaw.tokens.input": 64,
        "openclaw.tokens.output": 24,
        "openclaw.tokens.total": 88,
      });
      expect(
        activeReceiver.capturedSpans
          .slice(llmTaskSpanCursor)
          .filter(
            (span) =>
              span.name === "openclaw.model.usage" &&
              span.attributes["openclaw.channel"] === "unknown" &&
              span.attributes["openclaw.tokens.input"] === 64 &&
              span.attributes["openclaw.tokens.output"] === 24 &&
              span.attributes["openclaw.tokens.total"] === 88,
          )
          .map((span) => span.attributes["openclaw.plugin"]),
      ).toEqual(["llm-task"]);
      const attributedUsageSpans = activeReceiver.capturedSpans.filter(
        (span) => span.attributes["openclaw.plugin"] !== undefined,
      );
      expect(
        attributedUsageSpans.map((span) => ({
          name: span.name,
          pluginId: span.attributes["openclaw.plugin"],
        })),
      ).toEqual([{ name: "openclaw.model.usage", pluginId: "llm-task" }]);

      const exportedBodies = Object.values(activeReceiver.capturedBodyText).flat().join("\n");
      expect(exportedBodies).not.toContain("qa-plugin-usage-secret-sentinel");
      phase = "fixture cleanup";
    } finally {
      cleanupStartedAfterMs = Math.round(performance.now() - startedAt);
      await settleCleanup(
        {
          gateway: () => stopQaGatewayFixture(gatewayOwner),
          provider: async () => {
            await mock?.stop();
          },
          receiver: async () => {
            await receiver?.close();
          },
          bus: async () => {
            await bus?.stop();
          },
        },
        pendingCleanupOwners,
      );
    }
  }, 120_000);
});
