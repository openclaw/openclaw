import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const hookEvent = { messages: [] as string[] };
  return {
    hookEvent,
    triggerInternalHook: vi.fn(async () => undefined),
    createInternalHookEvent: vi.fn(() => hookEvent),
    runBeforeReset: vi.fn(async () => undefined),
    hasHooks: vi.fn(() => true),
    readFile: vi.fn(async () => ""),
  };
});

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: (...args: unknown[]) => mocks.readFile(...args),
  },
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: (...args: unknown[]) => mocks.createInternalHookEvent(...args),
  triggerInternalHook: (...args: unknown[]) => mocks.triggerInternalHook(...args),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (...args: unknown[]) => mocks.hasHooks(...args),
    runBeforeReset: (...args: unknown[]) => mocks.runBeforeReset(...args),
  }),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

const { emitResetCommandHooks, DEFAULT_SMART_RESET_REVIEW_PROMPT } = await import("./commands-core.js");

function makeParams(cfg: Record<string, unknown>) {
  return {
    action: "new" as const,
    ctx: {},
    cfg,
    command: {
      surface: "native",
      senderId: "u1",
      channel: "discord",
      from: "u1",
      to: "c1",
      resetHookTriggered: false,
    },
    sessionKey: "agent:main:discord:direct:u1",
    sessionEntry: {},
    previousSessionEntry: {},
    workspaceDir: "/tmp/workspace",
  };
}

describe("emitResetCommandHooks smart reset", () => {
  it("keeps default behavior unchanged when smart reset is disabled", async () => {
    const deferred = Promise.withResolvers<void>();
    mocks.runBeforeReset.mockImplementationOnce(() => deferred.promise);

    await emitResetCommandHooks(makeParams({ session: {} }));

    expect(mocks.runBeforeReset).toHaveBeenCalledWith(
      expect.objectContaining({ reviewPrompt: undefined }),
      expect.anything(),
    );
    deferred.resolve();
  });

  it("invokes smart mode with default prompt when enabled", async () => {
    await emitResetCommandHooks(makeParams({ session: { smartReset: { enabled: true } } }));

    expect(mocks.runBeforeReset).toHaveBeenLastCalledWith(
      expect.objectContaining({ reviewPrompt: DEFAULT_SMART_RESET_REVIEW_PROMPT }),
      expect.anything(),
    );
  });

  it("uses configurable prompt override", async () => {
    await emitResetCommandHooks(
      makeParams({ session: { smartReset: { enabled: true, prompt: "save key decisions" } } }),
    );

    expect(mocks.runBeforeReset).toHaveBeenLastCalledWith(
      expect.objectContaining({ reviewPrompt: "save key decisions" }),
      expect.anything(),
    );
  });

  it("wait=true blocks until review completion", async () => {
    let finished = false;
    const deferred = Promise.withResolvers<void>();
    mocks.runBeforeReset.mockImplementationOnce(async () => {
      await deferred.promise;
      finished = true;
    });

    const run = emitResetCommandHooks(
      makeParams({ session: { smartReset: { enabled: true, wait: true } } }),
    );

    await Promise.resolve();
    expect(finished).toBe(false);
    deferred.resolve();
    await run;
    expect(finished).toBe(true);
  });

  it("wait=false is fire-and-forget", async () => {
    const deferred = Promise.withResolvers<void>();
    let finished = false;
    mocks.runBeforeReset.mockImplementationOnce(async () => {
      await deferred.promise;
      finished = true;
    });

    await emitResetCommandHooks(
      makeParams({ session: { smartReset: { enabled: true, wait: false } } }),
    );

    expect(finished).toBe(false);
    deferred.resolve();
    await Promise.resolve();
  });
});
