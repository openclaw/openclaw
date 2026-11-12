import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect } from "vitest";
import { appendTranscriptMessages } from "../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../../src/gateway/client.ts";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import type { ControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export const selectedKey = "agent:main:loading-proof-12345678-0000-4000-8000-000000000001";
export const homeKey = "agent:main:main";
export const transcriptLength = 900;
export const viewport = { width: 1440, height: 900 };

export type RpcMetric = {
  requestId: string;
  method: string;
  sentMs: number;
  receivedMs?: number;
  responseBytes?: number;
  sessionKey?: string;
  agentId?: string;
  shortId?: string;
  resolveParams?: Record<string, unknown>;
  limit?: number;
  maxBytes?: number;
  offset?: number;
  cursor?: string;
  olderCursor?: string;
  newerCursor?: string;
  sourceNumbers?: number[];
  messages?: number;
  historyBytes?: number;
  initialHistory?: boolean;
  cursorPresent?: boolean;
  historyKind?: "window" | "delta" | "reset";
  historyOk?: boolean;
  resolvedKey?: string;
  resolvedAgentId?: string;
  resolutionOk?: boolean;
  inlineAvatar?: boolean;
};

export const selectRpc = (metrics: readonly RpcMetric[], method: string, sessionKey?: string) =>
  metrics.filter(
    (metric) =>
      metric.method === method && (sessionKey === undefined || metric.sessionKey === sessionKey),
  );
export const selectStartupHistory = (metrics: readonly RpcMetric[], sessionKey: string) =>
  metrics.filter(
    (metric) =>
      (metric.method === "chat.startup" || metric.initialHistory) &&
      metric.sessionKey === sessionKey,
  );
export const redactFixtureTokens = (text: string, owner: OpenClawTestInstance) =>
  [owner.gatewayToken, owner.hookToken].reduce(
    (redacted, token) => redacted.replaceAll(token, "[redacted fixture token]"),
    text,
  );

let seeded = false;

export async function prepareChatLoadingScenario(
  test: Parameters<ControlUiE2eSuite["runScenario"]>[0],
  suite: ControlUiE2eSuite,
  instance: OpenClawTestInstance | undefined,
  config: OpenClawConfig,
) {
  if (!instance) {
    throw new Error("Gateway fixture is not running");
  }
  const owner = instance;
  const cliJson = async (args: string[]): Promise<Record<string, unknown>> => {
    const result = await owner.cli(["--no-color", ...args]);
    if (result.code !== 0) {
      const diagnostic = redactFixtureTokens([result.stderr, result.stdout].join("\n"), owner);
      throw new Error(
        `${args.slice(0, 3).join(" ")} failed (exit ${String(result.code)}): ${diagnostic}`,
      );
    }
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  const sessions = [
    { key: selectedKey, label: "Synthetic loading proof", count: transcriptLength },
    { key: homeKey, label: "Synthetic Home", count: transcriptLength },
    ...Array.from({ length: 3 }, (_, index) => ({
      key: `agent:main:unopened-${index}`,
      label: `Unopened synthetic conversation ${index + 1}`,
      count: 150,
    })),
  ];
  let setupClient: GatewayClient | undefined;
  let failedAcquisitionCleanup: Promise<void> | undefined;
  await suite.runScenario(test, {
    retainedState: () => owner.state.root,
    async run(signal) {
      if (seeded) {
        return;
      }
      const client = await acquireGatewayTestClient(
        {
          url: owner.url,
          token: owner.gatewayToken,
          env: owner.env,
          clientName: "cli",
          mode: "cli",
          role: "operator",
          instanceId: randomUUID(),
          scopes: ["operator.write"],
          caps: ["ultrafast"],
          deviceIdentity: null,
          deviceAuthScope: owner.url,
          sharedStateMode: "read-only",
          requestTimeoutMs: 10_000,
        },
        {
          signal,
          timeoutMs: 10_000,
          timeoutMessage: "Loading setup client did not connect",
          closeMessage: "Loading setup client closed during connect",
          verifyCleanup: (cleanup) => (failedAcquisitionCleanup = cleanup()),
        },
      );
      setupClient = client;
      const syntheticViewer = await client.request("users.list", {}, { signal });
      expect(
        Array.isArray(syntheticViewer.profiles) &&
          syntheticViewer.profiles.some(
            (profile) =>
              isRecord(profile) &&
              profile.id === "gateway-owner" &&
              profile.displayName === "Synthetic Viewer",
          ),
      ).toBe(true);
      for (const session of sessions) {
        signal.throwIfAborted();
        const created = await client.request(
          "sessions.create",
          {
            key: session.key,
            agentId: "main",
            label: session.label,
          },
          { signal, retainSentResultOnAbort: true },
        );
        expect(created.ok).toBe(true);
        signal.throwIfAborted();
        await appendTranscriptMessages(
          {
            agentId: "main",
            sessionKey: session.key,
            sessionId: String(created.sessionId),
            env: owner.env,
          },
          {
            config,
            messages: Array.from({ length: session.count }, (_, index) => ({
              message: chatMessage(
                index % 2 === 0 ? "user" : "assistant",
                `${session.label} message ${index + 1}.\n\n${"Synthetic transcript content for loading and pagination. ".repeat(72)}`,
                { timestamp: 1_780_000_000_000 + index * 1000 },
              ),
            })),
          },
        );
      }
      signal.throwIfAborted();
      seeded = true;
    },
    async close() {
      await failedAcquisitionCleanup;
      await setupClient?.stopAndWait();
    },
  });
  const handoff = await cliJson(["dashboard", "--json"]);
  const url = new URL("/chat/main/12345678", suite.server.baseUrl);
  url.hash = new URL(String(handoff.browserUrl)).hash;
  return url;
}

export function observeChatLoadingRpc(
  page: Page,
  rpc: RpcMetric[],
  clock: { measuring: boolean; startedAt: number },
) {
  const pending = new Map<string, RpcMetric>();
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (!clock.measuring) {
        return;
      }
      const frame: unknown = JSON.parse(payload.toString());
      if (!isRecord(frame) || typeof frame.id !== "string" || typeof frame.method !== "string") {
        return;
      }
      const params = isRecord(frame.params) ? frame.params : {};
      const initialHistory =
        frame.method === "sessions.messages.subscribe" && isRecord(params.initialHistory)
          ? params.initialHistory
          : undefined;
      const historyParams = initialHistory ?? params;
      const metric: RpcMetric = {
        requestId: frame.id,
        method: frame.method,
        sentMs: Date.now() - clock.startedAt,
        ...(typeof params.sessionKey === "string"
          ? { sessionKey: params.sessionKey }
          : initialHistory && typeof params.key === "string"
            ? { sessionKey: params.key }
            : {}),
        ...(initialHistory ? { initialHistory: true } : {}),
        ...(initialHistory || ["chat.startup", "chat.history"].includes(frame.method)
          ? { cursorPresent: typeof historyParams.cursor === "string" }
          : {}),
        ...(typeof params.agentId === "string" ? { agentId: params.agentId } : {}),
        ...(typeof params.shortId === "string" ? { shortId: params.shortId } : {}),
        ...(frame.method === "sessions.resolve" ? { resolveParams: params } : {}),
        ...(typeof historyParams.limit === "number" ? { limit: historyParams.limit } : {}),
        ...(typeof historyParams.maxBytes === "number" ? { maxBytes: historyParams.maxBytes } : {}),
        ...(typeof historyParams.offset === "number" ? { offset: historyParams.offset } : {}),
        ...(typeof historyParams.cursor === "string" ? { cursor: historyParams.cursor } : {}),
      };
      rpc.push(metric);
      pending.set(frame.id, metric);
    });
    socket.on("framereceived", ({ payload }) => {
      if (!clock.measuring) {
        return;
      }
      const frame: unknown = JSON.parse(payload.toString());
      if (!isRecord(frame) || typeof frame.id !== "string") {
        return;
      }
      const metric = pending.get(frame.id);
      if (!metric) {
        return;
      }
      pending.delete(frame.id);
      metric.receivedMs = Date.now() - clock.startedAt;
      metric.responseBytes = Buffer.byteLength(payload);
      const body = isRecord(frame.payload) ? frame.payload : {};
      const initialHistory = isRecord(body.initialHistory) ? body.initialHistory : undefined;
      const history = metric.initialHistory
        ? initialHistory?.ok === true && isRecord(initialHistory.payload)
          ? initialHistory.payload
          : undefined
        : body;
      metric.historyOk = frame.ok === true && history !== undefined;
      if (typeof history?.olderCursor === "string") {
        metric.olderCursor = history.olderCursor;
      }
      if (typeof history?.newerCursor === "string") {
        metric.newerCursor = history.newerCursor;
      }
      if (history?.kind === "delta" || history?.kind === "reset") {
        metric.historyKind = history.kind;
      } else if (Array.isArray(history?.messages)) {
        metric.historyKind = "window";
      }
      if (Array.isArray(history?.messages)) {
        metric.messages = history.messages.length;
        metric.sourceNumbers = history.messages.map((message) =>
          Number(JSON.stringify(message).match(/Synthetic loading proof message (\d+)\./u)?.[1]),
        );
        metric.historyBytes = Buffer.byteLength(JSON.stringify(history.messages));
      }
      if (metric.method === "sessions.resolve" && typeof body.key === "string") {
        metric.resolvedKey = body.key;
        metric.resolvedAgentId = typeof body.agentId === "string" ? body.agentId : undefined;
        metric.resolutionOk = frame.ok === true && body.ok === true;
      }
      metric.inlineAvatar = JSON.stringify(body).includes("data:image/");
    });
  });
  return pending;
}
