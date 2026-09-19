import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { RawData } from "ws";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { enqueueSystemEvent, peekSystemEventEntries } from "../infra/system-events.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  writeSessionStore,
} from "./test-helpers.server.js";

// Exercise accepted heartbeat publication through real Gateway sockets and history.
installGatewayTestHooks({ scope: "suite" });

const cleanupDirs: string[] = [];
const requireRecord = createRequireRecord("object", "expected-label-object");
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
});

afterAll(async () => {
  if (harness) {
    await harness.close();
  }
});

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
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
  test.each([false, true])(
    "commits exec completion once with WebChat disconnected=%s",
    async (disconnected) => {
      const storePath = await createSessionStoreFile();
      const sessionId = `exec-completion-${disconnected}`;
      const sessionKey = `agent:main:dashboard:exec-completion-${disconnected}`;
      const marker = `EXEC_NOTIFICATION_${disconnected}`;
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
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: path.dirname(storePath),
            heartbeat: { every: "5m", target: "last" },
          },
        },
        messages: { visibleReplies: "message_tool" },
        session: { store: storePath },
      };
      const deviceIdentityPath = path.join(path.dirname(storePath), "exec-web-device.json");
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
        enqueueSystemEvent(`Exec completed (webchat-proof, code 0) :: ${marker}`, { sessionKey });
        const reply = vi.fn().mockResolvedValue(
          createHeartbeatToolResponsePayload({
            outcome: "done",
            notify: true,
            summary: "Private execution summary",
            notificationText: marker,
          }),
        );
        const wake = () =>
          runHeartbeatOnce({
            cfg,
            agentId: "main",
            sessionKey,
            source: "exec-event",
            intent: "event",
            reason: "exec-event",
            deps: { getReplyFromConfig: reply },
          });
        expect((await wake()).status).toBe("ran");
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        if (live) {
          const event = requireRecord((await live).payload, "exec completion event");
          expect(event.message).toMatchObject({
            role: "assistant",
            content: [{ type: "text", text: marker }],
          });
        }
        expect((await wake()).status).toBe("skipped");
        expect(reply).toHaveBeenCalledOnce();
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
        ws.off("message", collect);
        ws.close();
        reconnected?.close();
      }
    },
  );
});
