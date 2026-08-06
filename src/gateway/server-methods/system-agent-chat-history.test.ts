import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test-utils/deferred.js";
import { systemAgentChatHistoryHandler } from "./system-agent-chat-history.js";
import { getSystemAgentSessionQueue } from "./system-agent-session-queue.js";
import type { GatewayClient } from "./types.js";

const turns = [
  { role: "user" as const, text: "one", at: 1 },
  { role: "assistant" as const, text: "two", at: 2 },
];

const transcriptStoreMocks = vi.hoisted(() => ({
  readTranscriptTail: vi.fn(),
}));

vi.mock("../../system-agent/transcript-store.js", () => ({
  readTranscriptTail: transcriptStoreMocks.readTranscriptTail,
}));

const ownerClient = {
  connId: "conn-owner",
  connect: { device: { id: "device-owner" } },
} as GatewayClient;

function makeInvocation(params: {
  sessionId?: string;
  client?: GatewayClient;
  activeWizardStep?: ReturnType<typeof vi.fn>;
}) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const activeWizardStep = params.activeWizardStep ?? vi.fn().mockResolvedValue(undefined);
  const session = {
    ownerKey: "device:device-owner",
    engine: { activeWizardStep },
    lastUsedAt: 1,
  };
  const context = {
    systemAgentSessions: new Map(params.sessionId ? [[params.sessionId, session]] : []),
  };
  const options = {
    params: params.sessionId ? { sessionId: params.sessionId } : {},
    client: params.client ?? ownerClient,
    context,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
  } as never;
  return { activeWizardStep, calls, context, options, session };
}

describe("openclaw.chat.history wizard recovery", () => {
  beforeEach(() => {
    transcriptStoreMocks.readTranscriptTail.mockReset().mockReturnValue(turns);
  });

  it("returns an active wizard only to its bound owner", async () => {
    const activeWizardStep = vi.fn().mockResolvedValue({
      id: "secret",
      type: "text",
      message: "Bot token",
      sensitive: true,
    });
    const owner = makeInvocation({ sessionId: "recover-session", activeWizardStep });

    await systemAgentChatHistoryHandler(owner.options);

    expect(owner.calls).toEqual([
      {
        ok: true,
        payload: {
          turns,
          activeWizard: {
            sessionId: "recover-session",
            step: {
              id: "secret",
              type: "text",
              message: "Bot token",
              sensitive: true,
            },
          },
        },
        error: undefined,
      },
    ]);
    expect(activeWizardStep).toHaveBeenCalledOnce();
    expect(owner.session.lastUsedAt).toBeGreaterThan(1);

    const foreign = makeInvocation({
      sessionId: "recover-session",
      client: {
        connId: "conn-foreign",
        connect: { device: { id: "device-foreign" } },
      } as GatewayClient,
      activeWizardStep,
    });

    await systemAgentChatHistoryHandler(foreign.options);

    expect(foreign.calls).toEqual([
      {
        ok: true,
        payload: { turns },
        error: undefined,
      },
    ]);
    expect(activeWizardStep).toHaveBeenCalledOnce();
    expect(foreign.session.lastUsedAt).toBe(1);
  });

  it("waits for the session queue before reading the recovery transcript", async () => {
    const turnStarted = createDeferred();
    const releaseTurn = createDeferred();
    let turnCommitted = false;
    transcriptStoreMocks.readTranscriptTail.mockImplementation(() =>
      turnCommitted
        ? [
            { role: "user", text: "committed question", at: 2 },
            { role: "assistant", text: "committed reply", at: 3 },
          ]
        : [{ role: "assistant", text: "older reply", at: 1 }],
    );
    const invocation = makeInvocation({ sessionId: "recover-session" });
    const turn = getSystemAgentSessionQueue(invocation.context.systemAgentSessions).enqueue(
      "recover-session",
      async () => {
        turnStarted.resolve();
        await releaseTurn.promise;
        turnCommitted = true;
      },
    );
    await turnStarted.promise;

    const history = systemAgentChatHistoryHandler(invocation.options);
    await Promise.resolve();
    const callsBeforeRelease = [...invocation.calls];
    releaseTurn.resolve();
    await Promise.all([turn, history]);

    expect(callsBeforeRelease).toEqual([]);
    expect(invocation.calls).toEqual([
      {
        ok: true,
        payload: {
          turns: [
            { role: "user", text: "committed question", at: 2 },
            { role: "assistant", text: "committed reply", at: 3 },
          ],
        },
        error: undefined,
      },
    ]);
  });
});
