import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type { RawData } from "ws";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { withinTest } from "../../test/helpers/promise.js";
import { withFullRuntimeReplyConfig } from "../auto-reply/reply/get-reply-fast-path.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
  type SessionEventReceipt,
} from "../auto-reply/reply/session-event-handoff.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { peekSystemEventEntries } from "../infra/system-events.js";
import { removeSessionTestDirectories } from "./session-test-directories.test-support.js";
import { gatewayReplyMock, testState } from "./test-helpers.runtime-state.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  writeSessionStore,
} from "./test-helpers.server.js";

// Exercise accepted session-event publication through real Gateway sockets and history.
installGatewayTestHooks({ scope: "suite" });

const cleanupDirs: string[] = [];
const requireRecord = createRequireRecord("object", "expected-label-object");
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let provider: Awaited<ReturnType<typeof startOpenAiResponsesModelServer>>;
let completionText: string;
const providerRequests: string[] = [];

beforeAll(async () => {
  // Keep embedded execution and transcript ownership; only the HTTP response is synthetic.
  provider = await startOpenAiResponsesModelServer({
    modelId: "exec-completion",
    bindError: "Expected exec completion fixture provider address",
    onRequest: async (request, response) => {
      providerRequests.push(await text(request));
      writeOpenAiResponsesText(response, {
        text: completionText,
        messageId: `msg_exec_${providerRequests.length}`,
        responseId: `resp_exec_${providerRequests.length}`,
      });
    },
  });
  harness = await createGatewaySuiteHarness();
});

afterAll(async () => {
  try {
    if (harness) {
      await harness.close();
    }
  } finally {
    await provider?.close();
  }
});

afterEach(async () => {
  await removeSessionTestDirectories(cleanupDirs.splice(0));
});

// Give each connection scenario an isolated authoritative session store.
async function createSessionStoreFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-message-"));
  cleanupDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  return storePath;
}

// Observe the canonical session.message event on the subscribed connection.
function waitForSessionMessageEvent(
  ws: Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>,
  sessionKey: string,
  timeoutMs?: number,
) {
  return onceMessage(
    ws,
    (message) =>
      message.type === "event" &&
      message.event === "session.message" &&
      asOptionalRecord(message.payload)?.sessionKey === sessionKey,
    timeoutMs,
  );
}

describe("exec completion WebChat publication", () => {
  test.for([false, true])(
    "commits exec completion once with WebChat disconnected=%s",
    async (disconnected, { signal }) => {
      const storePath = await createSessionStoreFile();
      const sessionId = `exec-completion-${disconnected}`;
      const sessionKey = `agent:main:dashboard:exec-completion-${disconnected}`;
      const marker = `EXEC_NOTIFICATION_${disconnected}`;
      completionText = marker;
      providerRequests.length = 0;
      await writeSessionStore({
        entries: {
          [sessionKey]: {
            sessionId,
            lifecycleRevision: "exec-completion-generation",
            updatedAt: Date.now(),
            createdVia: "operator",
            delivery: { kind: "internal" },
          },
        },
        storePath,
      });
      const modelConfig = createOpenAiResponsesModelConfig({
        baseUrl: provider.baseUrl,
        providerId: "exec-proof",
        modelId: "exec-completion",
        reasoning: false,
        toolProfile: "full",
      });
      const cfg: OpenClawConfig = {
        ...modelConfig,
        agents: {
          ...modelConfig.agents,
          entries: { main: {} },
          defaults: {
            ...modelConfig.agents?.defaults,
            workspace: path.dirname(storePath),
          },
        },
        messages: { visibleReplies: "message_tool" },
        session: { store: storePath },
      };
      const deviceIdentityPath = path.join(
        path.dirname(storePath),
        "exec-web-device",
        "client",
        "credentials.sqlite",
      );
      const connect = async () => {
        const ws = await harness.openWs({ origin: `http://127.0.0.1:${harness.port}` });
        await connectOk(ws, {
          caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
          client: {
            id: GATEWAY_CLIENT_IDS.CONTROL_UI,
            mode: GATEWAY_CLIENT_MODES.UI,
            platform: "web",
            version: "test",
          },
          deviceIdentityPath,
          prePairDevice: true,
          scopes: ["operator.read"],
        });
        await rpcReq(ws, "sessions.messages.subscribe", { key: sessionKey });
        return ws;
      };
      const ws = await connect();
      let reconnected: Awaited<ReturnType<typeof connect>> | undefined;
      let receipt: SessionEventReceipt | undefined;
      const notifications: unknown[] = [];
      const collect = (data: RawData) => {
        const event = asOptionalRecord(JSON.parse(rawDataToString(data)));
        const payload = asOptionalRecord(event?.payload);
        if (
          event?.event === "session.message" &&
          payload?.sessionKey === sessionKey &&
          JSON.stringify(payload.message).includes(marker)
        ) {
          notifications.push(payload);
        }
      };
      ws.on("message", collect);
      try {
        if (disconnected) {
          const closed = new Promise<void>((resolve) => {
            ws.once("close", () => resolve());
          });
          ws.close();
          await closed;
        }
        const live = disconnected ? undefined : waitForSessionMessageEvent(ws, sessionKey);
        await prepareGatewayReplyRuntimeForTest({ force: true, config: cfg });
        gatewayReplyMock.mockImplementation((ctx, options, config) =>
          getReplyFromConfig(ctx, options, withFullRuntimeReplyConfig(config ?? cfg)),
        );
        receipt = enqueueSessionEventForHost(
          `Exec completed (webchat-proof, code 0) :: ${marker}`,
          {
            agentId: "main",
            sessionKey,
            source: "exec",
            expectedTarget: await captureSessionEventTargetForHost("main", sessionKey),
            abortSignal: signal,
          },
        );
        await expect(receipt.accepted).resolves.toEqual({ ok: true });
        expect(await withinTest(receipt.settled, signal)).toMatchObject({
          status: "completed",
          executionStarted: true,
        });
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        if (live) {
          const event = requireRecord((await live).payload, "exec completion event");
          expect(event.message).toMatchObject({
            role: "assistant",
            content: [{ type: "text", text: marker }],
          });
        }
        expect(providerRequests.filter((request) => request.includes(marker))).toHaveLength(1);
        if (!disconnected) {
          const closed = new Promise<void>((resolve) => {
            ws.once("close", () => resolve());
          });
          ws.close();
          await closed;
        }
        reconnected = await connect();
        const history = await rpcReq<{ messages?: unknown[] }>(reconnected, "chat.history", {
          sessionKey,
        });
        expect(history.ok).toBe(true);
        const completions = history.payload?.messages?.filter((message) =>
          JSON.stringify(message).includes(marker),
        );
        expect(completions).toHaveLength(1);
        expect(notifications).toHaveLength(disconnected ? 0 : 1);
      } finally {
        receipt?.cancel();
        await Promise.allSettled(receipt ? [receipt.settled] : []);
        gatewayReplyMock.mockReset();
        ws.off("message", collect);
        ws.close();
        reconnected?.close();
      }
    },
  );
});
