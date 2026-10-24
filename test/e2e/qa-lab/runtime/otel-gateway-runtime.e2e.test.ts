import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, onTestFailed, test } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  startQaBusServer,
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { otelTraceConfig, settleOtelCleanup } from "./otel-runtime.test-support.js";
import { type CapturedSpan, startLocalOtlpReceiver } from "./otel-test-support.js";

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs: number,
  timeoutContext: () => unknown,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for QA runtime evidence: ${JSON.stringify(timeoutContext())}`);
}

const levels = ["openclaw.harness.run", "openclaw.run", "openclaw.model.call"];
function traceLayers(spans: CapturedSpan[]) {
  const terminal = spans.find(
    (span) =>
      span.name === "openclaw.message.processed" &&
      span.attributes["openclaw.channel"] === "qa-channel" &&
      span.attributes["openclaw.outcome"] === "completed",
  );
  return { terminal, layers: levels.map((name) => spans.filter((span) => span.name === name)) };
}

function expectTraceParents(spans: CapturedSpan[], tool: CapturedSpan) {
  const { terminal, layers } = traceLayers(spans);
  const spansById = new Map(
    spans.flatMap((span) => (span.spanId ? [[span.spanId, span] as const] : [])),
  );
  const parentOf = (span: CapturedSpan) => {
    expect(span.parentSpanId).toBeTruthy();
    const parent = span.parentSpanId ? spansById.get(span.parentSpanId) : undefined;
    expect(parent).toBeDefined();
    return parent!;
  };
  expect(terminal).toBeDefined();
  expect(terminal?.parentSpanId).toBeFalsy();
  for (const [index, children] of layers.entries()) {
    expect(children).toHaveLength([1, 1, 2][index]!);
    for (const child of children) {
      const parent = parentOf(child);
      if (index === 0) {
        expect(parent).toBe(terminal);
      } else {
        expect(parent.name).toBe(levels[index - 1]);
      }
    }
  }
  expect(parentOf(tool).name).toBe("openclaw.run");
}

test("exports linked failed-read recovery and attributed plugin-usage spans", async () => {
  const state = createQaBusState();
  const transport = createQaChannelTransport(state);
  let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
  let receiver: ReturnType<typeof startLocalOtlpReceiver> | undefined;
  let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
  const gatewayOwner = createQaGatewayChild();
  let gatewayLogs: (() => string) | undefined;
  onTestFailed(() => {
    process.stderr.write(`${gatewayLogs?.().slice(-12_000) ?? ""}\n`);
    process.stderr.write(`${JSON.stringify(receiver?.recentTraceSummary())}\n`);
  });

  try {
    bus = await startQaBusServer({ state });
    const activeReceiver = startLocalOtlpReceiver();
    const receiverPort = await activeReceiver.listen();
    receiver = activeReceiver;
    mock = await startQaMockOpenAiServer();
    const gateway = await gatewayOwner.start({
      repoRoot: path.resolve(import.meta.dirname, "../../../.."),
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transport,
      transportBaseUrl: bus.baseUrl,
      enabledPluginIds: ["diagnostics-otel", "llm-task"],
      controlUiEnabled: false,
      mutateConfig: (cfg) => ({
        ...cfg,
        session: { ...cfg.session, dmScope: "per-peer" },
        tools: {
          ...cfg.tools,
          alsoAllow: [...(cfg.tools?.alsoAllow ?? []), "llm-task"],
          codeMode: {
            ...(typeof cfg.tools?.codeMode === "object" ? cfg.tools.codeMode : {}),
            enabled: true,
          },
        },
        diagnostics: otelTraceConfig({ endpoint: `http://127.0.0.1:${receiverPort}` }, 1, 1000),
      }),
    });
    gatewayLogs = gateway.logs;
    const conversation = { id: "qa-operator", kind: "direct" as const };
    const send = async (text: string, expectedText: string, targetConversation = conversation) => {
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

    const recovered = await send(
      "Failed tool terminal recovery QA check: read the missing workspace file, then respond with exact marker: `QA-FAILED-TOOL-FINALIZED-OK`.",
      "QA-FAILED-TOOL-FINALIZED-OK",
    );
    expect(recovered.text).toContain("The requested file could not be read: ENOENT.");

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
        const { terminal, layers } = traceLayers(sameTrace);
        return terminal && layers.every((group, index) => group.length >= [1, 1, 2][index]!)
          ? { sameTrace, toolError }
          : undefined;
      },
      45_000,
      () => ({
        requests: activeReceiver.capturedRequests.slice(-8),
        traces: activeReceiver.recentTraceSummary(),
      }),
    );

    expectTraceParents(failureEvidence.sameTrace, failureEvidence.toolError);

    const llmTaskSpanCursor = activeReceiver.capturedSpans.length;
    await send(
      "tool search qa check target=llm-task. Call exactly that tool once, then reply with only this exact marker: `OTEL-PLUGIN-USAGE-OK`.",
      "OTEL-PLUGIN-USAGE-OK",
      { id: "qa-plugin-usage", kind: "direct" },
    );

    const usageAttributes = {
      "openclaw.tokens.input": 64,
      "openclaw.tokens.output": 24,
      "openclaw.tokens.total": 88,
    };
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
    expect(llmTaskUsage.attributes).toMatchObject(usageAttributes);
    expect(
      activeReceiver.capturedSpans
        .slice(llmTaskSpanCursor)
        .filter(
          (span) =>
            span.name === "openclaw.model.usage" &&
            span.attributes["openclaw.channel"] === "unknown" &&
            Object.entries(usageAttributes).every(([key, value]) => span.attributes[key] === value),
        )
        .map((span) => span.attributes["openclaw.plugin"]),
    ).toEqual(["llm-task"]);
    const attributedUsageSpans = activeReceiver.capturedSpans.filter(
      (span) => span.attributes["openclaw.plugin"] !== undefined,
    );
    expect(attributedUsageSpans).toMatchObject([
      { name: "openclaw.model.usage", attributes: { "openclaw.plugin": "llm-task" } },
    ]);
  } finally {
    await settleOtelCleanup(
      () => stopQaGatewayFixture(gatewayOwner),
      async () => await mock?.stop(),
      async () => await receiver?.close(),
      async () => await bus?.stop(),
    );
  }
}, 120_000);
