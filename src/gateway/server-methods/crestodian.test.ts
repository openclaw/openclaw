// crestodian.chat handler tests: session reuse, reset, and action mapping.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrestodianChatEngine } from "../../crestodian/chat-engine.js";
import {
  getCommandLaneSnapshot,
  resetCommandQueueStateForTest,
} from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { createDeferred } from "../../test-utils/deferred.js";
import { crestodianHandlers, type CrestodianChatSession } from "./crestodian.js";
import type { GatewayRequestContext } from "./types.js";

const setupInferenceMocks = vi.hoisted(() => ({
  activateSetupInference: vi.fn(),
  detectSetupInference: vi.fn(),
  verifySetupInference: vi.fn(),
}));

vi.mock("../../crestodian/setup-inference.js", () => ({
  activateSetupInference: setupInferenceMocks.activateSetupInference,
  detectSetupInference: setupInferenceMocks.detectSetupInference,
  verifySetupInference: setupInferenceMocks.verifySetupInference,
}));

type RespondCall = {
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};

function makeRespond() {
  const calls: RespondCall[] = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  };
  return { calls, respond };
}

function makeContext(sessions: Map<string, CrestodianChatSession>): GatewayRequestContext {
  return { crestodianSessions: sessions } as unknown as GatewayRequestContext;
}

function seededSession(overrides?: Partial<CrestodianChatSession>): CrestodianChatSession {
  return {
    engine: new CrestodianChatEngine({}),
    welcome: "welcome text",
    lastUsedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  setupInferenceMocks.verifySetupInference.mockResolvedValue({
    ok: true,
    modelRef: "openai/gpt-5.5",
    latencyMs: 10,
  });
});

afterEach(() => {
  setupInferenceMocks.activateSetupInference.mockReset();
  setupInferenceMocks.detectSetupInference.mockReset();
  setupInferenceMocks.verifySetupInference.mockReset();
  resetCommandQueueStateForTest();
});

async function callChat(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
): Promise<RespondCall> {
  const { calls, respond } = makeRespond();
  await crestodianHandlers["crestodian.chat"]({
    params,
    respond,
    context,
  } as never);
  const call = calls[0];
  if (!call) {
    throw new Error("expected a respond call");
  }
  return call;
}

describe("crestodian.chat", () => {
  it("refuses to create a session before inference is available", async () => {
    setupInferenceMocks.verifySetupInference.mockResolvedValueOnce({
      ok: false,
      status: "unavailable",
      error: "no configured model",
    });
    const sessions = new Map<string, CrestodianChatSession>();

    const call = await callChat(makeContext(sessions), { sessionId: "s1" });

    expect(call).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Crestodian requires working inference: no configured model",
      },
    });
    expect(sessions.size).toBe(0);
  });

  it("coalesces concurrent initialization for the same session", async () => {
    const started = createDeferred();
    const release = createDeferred();
    setupInferenceMocks.verifySetupInference.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 10,
      };
    });
    const sessions = new Map<string, CrestodianChatSession>();
    const context = makeContext(sessions);

    const first = callChat(context, { sessionId: "shared" });
    await started.promise;
    const second = callChat(context, { sessionId: "shared" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release.resolve();
    const [firstCall, secondCall] = await Promise.all([first, second]);

    expect(setupInferenceMocks.verifySetupInference).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(1);
    expect(firstCall.ok).toBe(true);
    expect(secondCall.ok).toBe(true);
  });

  it("tracks setup detection until its RPC response is sent", async () => {
    const started = createDeferred();
    const release = createDeferred();
    setupInferenceMocks.detectSetupInference.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return {
        candidates: [],
        manualProviders: [],
        workspace: "/tmp/work",
        setupComplete: false,
      };
    });
    const activeAtResponse: number[] = [];

    const pending = crestodianHandlers["crestodian.setup.detect"]({
      params: {},
      respond: () => {
        activeAtResponse.push(getCommandLaneSnapshot(CommandLane.Crestodian).activeCount);
      },
    } as never);

    await started.promise;
    expect(getCommandLaneSnapshot(CommandLane.Crestodian).activeCount).toBe(1);
    release.resolve();
    await pending;

    expect(activeAtResponse).toEqual([1]);
    expect(getCommandLaneSnapshot(CommandLane.Crestodian).activeCount).toBe(0);
  });

  it("forwards setup activation on the gateway lane until its response is sent", async () => {
    const started = createDeferred();
    const release = createDeferred();
    const activationResult = {
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 250,
      lines: ["Default model: openai/gpt-5.5"],
    };
    setupInferenceMocks.activateSetupInference.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return activationResult;
    });
    const { calls, respond } = makeRespond();
    const activeAtResponse: number[] = [];

    const pending = crestodianHandlers["crestodian.setup.activate"]({
      params: {
        kind: "api-key",
        authChoice: "openai-api-key",
        apiKey: "test-key",
        workspace: "/tmp/work",
      },
      respond: (ok: boolean, payload?: unknown, error?: unknown) => {
        activeAtResponse.push(getCommandLaneSnapshot(CommandLane.Crestodian).activeCount);
        respond(ok, payload, error);
      },
    } as never);

    await started.promise;
    expect(getCommandLaneSnapshot(CommandLane.Crestodian).activeCount).toBe(1);
    release.resolve();
    await pending;

    expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledWith({
      kind: "api-key",
      authChoice: "openai-api-key",
      apiKey: "test-key",
      workspace: "/tmp/work",
      surface: "gateway",
      runtime: expect.objectContaining({ exit: expect.any(Function) }),
    });
    expect(calls).toEqual([{ ok: true, payload: activationResult, error: undefined }]);
    expect(activeAtResponse).toEqual([1]);
    expect(getCommandLaneSnapshot(CommandLane.Crestodian).activeCount).toBe(0);
  });

  it("rejects invalid params", async () => {
    const call = await callChat(makeContext(new Map()), {});
    expect(call.ok).toBe(false);
  });

  it("returns the stored welcome when no message is sent", async () => {
    const sessions = new Map<string, CrestodianChatSession>([["s1", seededSession()]]);
    const call = await callChat(makeContext(sessions), { sessionId: "s1" });
    expect(call.ok).toBe(true);
    expect(call.payload).toMatchObject({ sessionId: "s1", reply: "welcome text", action: "none" });
  });

  it("routes messages through the session engine", async () => {
    const engine = new CrestodianChatEngine({});
    const handle = vi
      .spyOn(engine, "handle")
      .mockResolvedValue({ text: "did the thing", action: "none" });
    const sessions = new Map<string, CrestodianChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "status" });

    expect(handle).toHaveBeenCalledWith("status");
    expect(call.payload).toMatchObject({ reply: "did the thing", action: "none" });
  });

  it("tracks concurrent requests as active until each RPC response is sent", async () => {
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();
    const releaseFirst = createDeferred();
    const releaseSecond = createDeferred();
    const firstEngine = new CrestodianChatEngine({});
    vi.spyOn(firstEngine, "handle").mockImplementation(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return { text: "first setup complete", action: "none" };
    });
    const secondEngine = new CrestodianChatEngine({});
    vi.spyOn(secondEngine, "handle").mockImplementation(async () => {
      secondStarted.resolve();
      await releaseSecond.promise;
      return { text: "second setup complete", action: "none" };
    });
    const sessions = new Map<string, CrestodianChatSession>([
      ["s1", seededSession({ engine: firstEngine })],
      ["s2", seededSession({ engine: secondEngine })],
    ]);
    const activeAtResponse: number[] = [];

    const first = crestodianHandlers["crestodian.chat"]({
      params: { sessionId: "s1", message: "yes" },
      context: makeContext(sessions),
      respond: () => {
        activeAtResponse.push(getCommandLaneSnapshot(CommandLane.Crestodian).activeCount);
      },
    } as never);
    const second = crestodianHandlers["crestodian.chat"]({
      params: { sessionId: "s2", message: "yes" },
      context: makeContext(sessions),
      respond: () => {
        activeAtResponse.push(getCommandLaneSnapshot(CommandLane.Crestodian).activeCount);
      },
    } as never);

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    expect(getCommandLaneSnapshot(CommandLane.Crestodian)).toMatchObject({
      activeCount: 2,
      queuedCount: 0,
    });
    releaseFirst.resolve();
    await first;
    expect(getCommandLaneSnapshot(CommandLane.Crestodian).activeCount).toBe(1);
    releaseSecond.resolve();
    await second;

    expect(activeAtResponse).toEqual([2, 1]);
    expect(getCommandLaneSnapshot(CommandLane.Crestodian).activeCount).toBe(0);
  });

  it("forwards sensitive-input metadata to clients", async () => {
    const engine = new CrestodianChatEngine({});
    vi.spyOn(engine, "handle").mockResolvedValue({
      text: "Enter the bot token",
      action: "none",
      sensitive: true,
    });
    const sessions = new Map<string, CrestodianChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "yes" });

    expect(call.payload).toMatchObject({ sensitive: true });
  });

  it("maps the TUI handoff to an open-agent action for clients", async () => {
    const engine = new CrestodianChatEngine({});
    vi.spyOn(engine, "handle").mockResolvedValue({
      text: "",
      action: "open-tui",
      handoff: { kind: "open-tui" },
    });
    const sessions = new Map<string, CrestodianChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "talk to agent",
    });

    expect(call.payload).toMatchObject({ action: "open-agent" });
    expect((call.payload as { reply: string }).reply).toContain("continue with your agent");
  });

  it("resets a session on request", async () => {
    const engine = new CrestodianChatEngine({});
    const handle = vi.spyOn(engine, "handle");
    const dispose = vi.spyOn(engine, "dispose").mockResolvedValue();
    const sessions = new Map<string, CrestodianChatSession>([["s1", seededSession({ engine })]]);
    // Reset drops the stored session; loading a fresh welcome would hit real
    // discovery, so stub the overview loader on the replacement engine path by
    // asserting the old engine is gone instead.
    const { calls, respond } = makeRespond();
    const context = makeContext(sessions);
    const pending = crestodianHandlers["crestodian.chat"]({
      params: { sessionId: "s1", reset: true },
      respond,
      context,
    } as never);
    await pending;
    expect(handle).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(sessions.get("s1")?.engine).not.toBe(engine);
    expect(calls[0]?.ok).toBe(true);
  });
});
