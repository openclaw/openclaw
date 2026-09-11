import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  startQaBusServer,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { listAgentIds } from "../../../../src/agents/agent-scope.js";
import { resolveAgentRoute } from "../../../../src/routing/resolve-route.js";
import {
  describeCodeModeOutbound,
  observeCodeModeTurnCompletion,
} from "../../../helpers/code-mode-turn-completion.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const accountId = "default";
const peerId = "code-mode-proof-peer";
const turns = [
  {
    outboundMarker: "QA-CODE-MODE-CURRENT-TURN-OUTBOUND",
    ordinaryFinalMarker: "QA-CODE-MODE-ORDINARY-FINAL",
  },
  {
    outboundMarker: "QA-CODE-MODE-SECOND-TURN-OUTBOUND",
    ordinaryFinalMarker: "QA-CODE-MODE-SECOND-ORDINARY-FINAL",
  },
];

let gatewayOwner: ReturnType<typeof createQaLiveLaneGateway> | undefined;
let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;

async function waitFor<T>(
  label: string,
  read: () => Promise<T | undefined> | T | undefined,
  diagnostic?: () => string,
) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}${diagnostic ? `: ${diagnostic()}` : ""}`);
}

async function waitForStableCompletion(params: {
  providerBaseUrl: string;
  readOutboundCount: () => number;
  diagnostic: () => string;
}) {
  const deadline = Date.now() + 45_000;
  let stableSince = 0;
  let previous: { providerRequests: number; outboundMessages: number } | undefined;
  while (Date.now() < deadline) {
    const [requestsResponse, inflightResponse] = await Promise.all([
      fetch(`${params.providerBaseUrl}/debug/requests`),
      fetch(`${params.providerBaseUrl}/debug/inflight-requests`),
    ]);
    expect(requestsResponse.ok).toBe(true);
    expect(inflightResponse.ok).toBe(true);
    const requests = (await requestsResponse.json()) as MockOpenAiRequestSnapshot[];
    const inflight = (await inflightResponse.json()) as unknown[];
    const current = {
      providerRequests: requests.length,
      outboundMessages: params.readOutboundCount(),
    };
    if (
      inflight.length === 0 &&
      previous?.providerRequests === current.providerRequests &&
      previous.outboundMessages === current.outboundMessages
    ) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= 1_000) {
        return { requests, inflight, counts: current };
      }
    } else {
      stableSince = 0;
    }
    previous = current;
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for stable provider and outbound completion: ${params.diagnostic()}`,
  );
}

afterEach(async () => {
  const errors: unknown[] = [];
  try {
    if (gatewayOwner) {
      await stopQaGatewayFixture(gatewayOwner);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    gatewayOwner = undefined;
  }
  try {
    await bus?.stop();
  } catch (error) {
    errors.push(error);
  } finally {
    bus = undefined;
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Code Mode delivery proof cleanup failed");
  }
});

describe("Code Mode current-turn delivery real Gateway proof", () => {
  for (const scenario of [
    { name: "acknowledged delivery", dropOutboundResponseAfterAccept: false },
    { name: "accepted delivery with a lost response", dropOutboundResponseAfterAccept: true },
  ]) {
    it(
      `uses one provider request per turn on the same session after ${scenario.name}`,
      { timeout: 120_000 },
      async () => {
        const state = createQaBusState();
        bus = await startQaBusServer({
          state,
          dropOutboundResponseAfterAccept: scenario.dropOutboundResponseAfterAccept,
        });
        gatewayOwner = createQaLiveLaneGateway();
        const harness = await gatewayOwner.start({
          repoRoot: process.cwd(),
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(process.cwd(), "scripts", "run-node.mjs")],
            cwd: process.cwd(),
          },
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna-alt",
          transport: createQaChannelTransport(state),
          transportBaseUrl: bus.baseUrl,
          controlUiEnabled: false,
          mutateConfig: (config) => ({
            ...config,
            tools: {
              ...config.tools,
              codeMode: { enabled: true },
            },
          }),
        });

        if (!harness.mock) {
          throw new Error("mock OpenAI provider did not start");
        }
        const packageJson = await readFile(
          path.join(harness.gateway.workspaceDir, "repo", "package.json"),
          "utf8",
        );
        expect(JSON.parse(packageJson)).toMatchObject({ name: "openclaw" });
        const route = resolveAgentRoute({
          cfg: harness.gateway.cfg,
          channel: "qa-channel",
          accountId,
          peer: { kind: "direct", id: `dm:${peerId}` },
        });
        expect(listAgentIds(harness.gateway.cfg)).toContain(route.agentId);
        let sessionId: string | undefined;
        for (const [index, turn] of turns.entries()) {
          const outboundDiagnostic = () =>
            describeCodeModeOutbound(
              state.getSnapshot().messages,
              turns.map((candidate) => candidate.outboundMarker),
              turns.map((candidate) => candidate.ordinaryFinalMarker),
            );
          state.addInboundMessage({
            accountId,
            conversation: { kind: "direct", id: peerId },
            senderId: peerId,
            text:
              `QA current-turn Code Mode delivery: send exactly \`${turn.outboundMarker}\`; ` +
              `if another provider request follows, reply exactly \`${turn.ordinaryFinalMarker}\``,
          });

          await waitFor(
            "current-turn outbound",
            () => {
              const outbound = state
                .getSnapshot()
                .messages.filter((message) => message.direction === "outbound");
              return outbound.some((message) => message.text === turn.outboundMarker)
                ? outbound
                : undefined;
            },
            () => JSON.stringify(outboundDiagnostic()),
          );
          const plannedResponse = await fetch(`${harness.mock.baseUrl}/debug/requests`);
          expect(plannedResponse.ok).toBe(true);
          const plannedRequests = (await plannedResponse.json()) as MockOpenAiRequestSnapshot[];
          const planned = plannedRequests[index];
          expect(planned?.plannedToolName).toBe("exec");
          expect(planned?.plannedToolArgs?.code).toContain(turn.outboundMarker);
          const plannedToolCallId = planned?.plannedToolCallId;
          const plannedToolItemId = planned?.plannedToolItemId;
          const plannedCode = planned?.plannedToolArgs?.code;
          if (
            typeof plannedToolCallId !== "string" ||
            typeof plannedToolItemId !== "string" ||
            typeof plannedCode !== "string"
          ) {
            throw new Error("current provider exec identity unavailable");
          }
          let completionDiagnostic = "history unavailable";
          const completion = await waitFor(
            "current completed exec transcript result",
            async () => {
              const payload = await harness.gateway.call(
                "chat.history",
                { sessionKey: route.sessionKey, agentId: route.agentId, limit: 20 },
                { timeoutMs: 10_000 },
              );
              const observed = observeCodeModeTurnCompletion({
                history: payload,
                sessionKey: route.sessionKey,
                sessionId,
                plannedToolCallId,
                plannedToolItemId,
                plannedCode,
                marker: turn.outboundMarker,
                deliveryStatus: scenario.dropOutboundResponseAfterAccept
                  ? "partial_failed"
                  : "sent",
              });
              if (observed.status === "pending") {
                completionDiagnostic = JSON.stringify({
                  reason: observed.reason,
                  diagnostics: observed.diagnostics,
                  outbound: outboundDiagnostic(),
                });
                return undefined;
              }
              return observed;
            },
            () => completionDiagnostic,
          );
          sessionId = completion.sessionId;
          const settled = await waitForStableCompletion({
            providerBaseUrl: harness.mock.baseUrl,
            readOutboundCount: () =>
              state.getSnapshot().messages.filter((message) => message.direction === "outbound")
                .length,
            diagnostic: () => JSON.stringify(outboundDiagnostic()),
          });
          const outbound = state
            .getSnapshot()
            .messages.filter((message) => message.direction === "outbound");

          expect(settled.inflight).toEqual([]);
          expect(
            settled.counts,
            JSON.stringify({
              completion: completion.diagnostics,
              outbound: outboundDiagnostic(),
            }),
          ).toEqual({
            providerRequests: index + 1,
            outboundMessages: index + 1,
          });
          expect(settled.requests).toHaveLength(index + 1);
          expect(settled.requests[index]).toMatchObject({
            plannedToolName: "exec",
            plannedToolCallId,
            plannedToolItemId,
          });
          expect(completion.toolCallId).toBe(`${plannedToolCallId}|${plannedToolItemId}`);
          expect(settled.requests[index]?.plannedToolArgs?.code).toContain(turn.outboundMarker);
          expect(outbound.map((message) => message.text)).toEqual(
            turns.slice(0, index + 1).map((completed) => completed.outboundMarker),
          );
          expect(
            outbound.some((message) =>
              turns.some((candidate) => candidate.ordinaryFinalMarker === message.text),
            ),
          ).toBe(false);
          expect(completion.messages.at(-1)).toMatchObject({
            role: "toolResult",
            toolName: "exec",
            toolCallId: completion.toolCallId,
          });
        }
      },
    );
  }
});
