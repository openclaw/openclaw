import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import type { GatewayRequestContext, RespondFn } from "./shared-types.js";

const persistGatewaySessionLifecycleEventMock = vi.hoisted(() => vi.fn());

vi.mock("../session-lifecycle-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-lifecycle-state.js")>();
  return {
    ...actual,
    persistGatewaySessionLifecycleEvent: (...args: unknown[]) =>
      persistGatewaySessionLifecycleEventMock(...args),
  };
});

installGatewayTestHooks({ scope: "suite" });

describe("chat.send dispatch-error lifecycle broadcasts", () => {
  beforeEach(() => {
    dispatchInboundMessageMock.mockReset();
    persistGatewaySessionLifecycleEventMock.mockReset().mockResolvedValue(true);
  });

  test("does not broadcast failed session status when persistence rejects", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: 1_000,
            status: "running",
            startedAt: 900,
          },
        },
      });

      dispatchInboundMessageMock.mockRejectedValueOnce(new Error("provider rejected request"));
      persistGatewaySessionLifecycleEventMock.mockImplementation((params: unknown) => {
        const phase = (params as { event?: { data?: { phase?: unknown } } }).event?.data?.phase;
        if (phase === "error") {
          return Promise.reject(new Error("store write failed"));
        }
        return Promise.resolve(true);
      });

      const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const broadcastToConnIds = vi.fn();
      const context = {
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        agentRunSeq: new Map<string, number>(),
        chatAbortControllers: new Map(),
        chatAbortedRuns: new Map(),
        chatRunBuffers: new Map(),
        chatDeltaSentAt: new Map(),
        chatDeltaLastBroadcastLen: new Map(),
        chatDeltaLastBroadcastText: new Map(),
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        broadcast: vi.fn(),
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-session"]),
        nodeSendToSession: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        dedupe: new Map(),
      } as unknown as GatewayRequestContext;

      const { chatHandlers } = await import("./chat.js");
      await chatHandlers["chat.send"]({
        req: {
          type: "req",
          id: "dispatch-error",
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "run: pwd",
            idempotencyKey: "idem-dispatch-error-persist-reject",
          },
        },
        params: {
          sessionKey: "main",
          message: "run: pwd",
          idempotencyKey: "idem-dispatch-error-persist-reject",
        },
        client: {
          connect: {
            client: {
              id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            },
            scopes: ["operator.write"],
          },
        } as never,
        isWebchatConnect: () => true,
        respond: ((ok, payload, error) => {
          responses.push({ ok, payload, error });
        }) as RespondFn,
        context,
      });

      await vi.waitFor(() => {
        expect(
          persistGatewaySessionLifecycleEventMock.mock.calls.some(([params]) => {
            const phase = (params as { event?: { data?: { phase?: unknown } } }).event?.data?.phase;
            return phase === "error";
          }),
        ).toBe(true);
      });

      expect(responses).toMatchObject([
        {
          ok: true,
          payload: { runId: "idem-dispatch-error-persist-reject", status: "started" },
        },
      ]);
      expect(
        broadcastToConnIds.mock.calls.some(([event, payload]) => {
          const eventPayload = payload as { phase?: unknown; runId?: unknown };
          return (
            event === "sessions.changed" &&
            eventPayload.phase === "error" &&
            eventPayload.runId === "idem-dispatch-error-persist-reject"
          );
        }),
      ).toBe(false);
    } finally {
      testState.sessionStorePath = undefined;
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });
});
