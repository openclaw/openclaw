import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  deletedAgent: vi.fn(),
  send: vi.fn(),
}));
const started = { runId: "run-new", status: "started" };

// mock-isolation: Follow-up routing uses synthetic entries instead of real session stores.
vi.mock("../session-utils.js", () => ({
  prepareDeletedAgentSessionCheck: mocks.deletedAgent,
}));
// mock-isolation: Follow-up routing supplies synthetic entries without a database worker.
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async (
    params: Parameters<
      typeof import("../session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
    >[0],
  ) => mocks.load(params.key, { agentId: params.agentId }),
}));
// mock-isolation: supply send outcomes without executing external chat turns.
vi.mock("./chat-send-external-entry.js", () => ({
  handleDirectExternalChatSend: mocks.send,
}));

import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionMessagingHandlers } from "./sessions-messaging.js";

let context: GatewayRequestContext;

async function send(
  params: Record<string, unknown>,
  method: "sessions.send" | "sessions.steer" = "sessions.send",
) {
  const respond = vi.fn<RespondFn>();
  const handler = expectDefined(sessionMessagingHandlers[method], method);
  await handler({
    req: { type: "req", id: method, method },
    params,
    respond,
    context,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

function loadSession(
  canonicalKey: string,
  sessionId: string,
  storePath = "/tmp/sessions.json",
  cfg: OpenClawConfig = {},
) {
  mocks.load.mockReturnValue({ cfg, canonicalKey, storePath, entry: { sessionId } });
}

function respondWith(payload: unknown) {
  mocks.send.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
    respond(true, payload, undefined, undefined);
  });
}

describe("sessions.send follow-up status", () => {
  afterEach(() => flushPendingSessionsChangedEvents());
  beforeEach(() => {
    context = {
      chatRunState: { runs: new Map() },
      dedupe: new Map(),
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      getRuntimeConfig: () => ({}),
    } as unknown as GatewayRequestContext;
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.deletedAgent.mockReturnValue(null);
    respondWith({ ...started });
  });

  it("rejects keys belonging to a deleted agent", async () => {
    const key = "agent:deleted-agent:main";
    loadSession(key, "sess-orphan");
    mocks.deletedAgent.mockReturnValue("deleted-agent");
    const respond = await send({ key, message: "hi" });
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Agent "deleted-agent" no longer exists in configuration',
    });
  });

  it("steers the selected global agent with committed receipt and interrupt facts", async () => {
    const cfg = { agents: { entries: { main: {}, work: {} } } };
    context.getRuntimeConfig = () => cfg;
    loadSession("global", "sess-work-global", "/tmp/work/sessions.json", cfg);
    const payload = {
      runId: "run-work",
      status: "started",
      messageSeq: 4,
      interruptedActiveRun: true,
    };
    respondWith(payload);
    const params = {
      agentId: "work",
      message: "@Bob follow-up",
      mentions: [{ profileId: "bob", start: 0, end: 4 }],
      idempotencyKey: "run-work",
    };
    const respond = await send({ key: "global", ...structuredClone(params) }, "sessions.steer");
    expect(mocks.load).toHaveBeenCalledWith("global", { agentId: "work" });
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        params: expect.objectContaining({
          sessionKey: "global",
          ...params,
          queueMode: "interrupt",
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, payload, undefined, undefined);
  });
});
