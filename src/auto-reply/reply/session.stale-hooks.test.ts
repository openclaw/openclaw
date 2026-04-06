import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { HookRunner } from "../../plugins/hooks.js";

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runSessionStart: vi.fn<HookRunner["runSessionStart"]>(),
  runSessionEnd: vi.fn<HookRunner["runSessionEnd"]>(),
  runBeforeReset: vi.fn<HookRunner["runBeforeReset"]>(),
}));

const internalHookMocks = vi.hoisted(() => ({
  triggerInternalHook: vi.fn().mockResolvedValue(undefined),
  createInternalHookEvent: vi.fn(
    (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
      type,
      action,
      sessionKey,
      context,
      timestamp: new Date(),
      messages: [],
    }),
  ),
}));

const commandsCoreMocks = vi.hoisted(() => ({
  loadBeforeResetTranscript: vi.fn().mockResolvedValue({
    sessionFile: "/mock/transcript.jsonl",
    messages: [{ role: "user", content: "hello" }],
  }),
}));

let initSessionState: typeof import("./session.js").initSessionState;

async function createStorePath(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(root, "sessions.json");
}

async function writeStore(
  storePath: string,
  store: Record<string, SessionEntry | Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
}

async function writeTranscript(
  storePath: string,
  sessionId: string,
  text = "hello",
): Promise<string> {
  const transcriptPath = path.join(path.dirname(storePath), `${sessionId}.jsonl`);
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "message",
      id: `${sessionId}-m1`,
      message: { role: "user", content: text },
    })}\n`,
    "utf-8",
  );
  return transcriptPath;
}

describe("lazy session reset hooks", () => {
  // Set up mocks and import once (beforeAll) to avoid repeated full module
  // reloads via vi.resetModules() which causes extreme startup latency on
  // Windows/Jiti environments (all TypeScript modules recompile from scratch).
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("../../plugins/hook-runner-global.js", () => ({
      getGlobalHookRunner: () =>
        ({
          hasHooks: hookRunnerMocks.hasHooks,
          runSessionStart: hookRunnerMocks.runSessionStart,
          runSessionEnd: hookRunnerMocks.runSessionEnd,
          runBeforeReset: hookRunnerMocks.runBeforeReset,
        }) as unknown as HookRunner,
    }));
    vi.doMock("../../hooks/internal-hooks.js", () => ({
      triggerInternalHook: internalHookMocks.triggerInternalHook,
      createInternalHookEvent: internalHookMocks.createInternalHookEvent,
    }));
    // Mock commands-reset-hooks to avoid pulling its dependency tree
    // (route-reply runtime, hook-runner-global, etc.) via session.ts's dynamic import.
    vi.doMock("./commands-reset-hooks.js", () => ({
      loadBeforeResetTranscript: commandsCoreMocks.loadBeforeResetTranscript,
    }));
    ({ initSessionState } = await import("./session.js"));
  });

  beforeEach(() => {
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runSessionStart.mockReset().mockResolvedValue(undefined);
    hookRunnerMocks.runSessionEnd.mockReset().mockResolvedValue(undefined);
    hookRunnerMocks.runBeforeReset.mockReset().mockResolvedValue(undefined);
    hookRunnerMocks.hasHooks.mockImplementation(
      (hookName) =>
        hookName === "session_start" || hookName === "session_end" || hookName === "before_reset",
    );
    internalHookMocks.triggerInternalHook.mockReset().mockResolvedValue(undefined);
    internalHookMocks.createInternalHookEvent.mockClear();
    commandsCoreMocks.loadBeforeResetTranscript.mockReset().mockResolvedValue({
      sessionFile: "/mock/transcript.jsonl",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires internal hook with action daily on stale daily session", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    const storePath = await createStorePath("openclaw-stale-daily");
    const transcriptPath = await writeTranscript(storePath, "old-session");
    const yesterday = Date.now() - 48 * 60 * 60 * 1000;
    await writeStore(storePath, {
      [sessionKey]: {
        sessionId: "old-session",
        sessionFile: transcriptPath,
        updatedAt: yesterday,
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "command",
      "daily",
      sessionKey,
      expect.objectContaining({ commandSource: "system" }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("fires internal hook with action idle on idle-expired session", async () => {
    const sessionKey = "agent:main:telegram:direct:456";
    const storePath = await createStorePath("openclaw-stale-idle");
    const transcriptPath = await writeTranscript(storePath, "idle-session");
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    await writeStore(storePath, {
      [sessionKey]: {
        sessionId: "idle-session",
        sessionFile: transcriptPath,
        updatedAt: threeHoursAgo,
      },
    });
    const cfg = {
      session: {
        store: storePath,
        reset: { mode: "idle", idleMinutes: 60 },
      },
    } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "still here?", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "command",
      "idle",
      sessionKey,
      expect.objectContaining({ commandSource: "system" }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("does not fire internal hook when session is fresh", async () => {
    const sessionKey = "agent:main:telegram:direct:789";
    const storePath = await createStorePath("openclaw-fresh");
    const transcriptPath = await writeTranscript(storePath, "fresh-session");
    await writeStore(storePath, {
      [sessionKey]: {
        sessionId: "fresh-session",
        sessionFile: transcriptPath,
        updatedAt: Date.now(),
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("does not fire lazy-path internal hook on manual /new (emitResetCommandHooks handles it)", async () => {
    const sessionKey = "agent:main:telegram:direct:101";
    const storePath = await createStorePath("openclaw-manual-new");
    const transcriptPath = await writeTranscript(storePath, "manual-session");
    await writeStore(storePath, {
      [sessionKey]: {
        sessionId: "manual-session",
        sessionFile: transcriptPath,
        updatedAt: Date.now(),
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "/new", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("fires before_reset plugin hook for stale session", async () => {
    const sessionKey = "agent:main:telegram:direct:202";
    const storePath = await createStorePath("openclaw-stale-plugin");
    const transcriptPath = await writeTranscript(storePath, "plugin-session", "important data");
    const yesterday = Date.now() - 48 * 60 * 60 * 1000;
    await writeStore(storePath, {
      [sessionKey]: {
        sessionId: "plugin-session",
        sessionFile: transcriptPath,
        updatedAt: yesterday,
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    // before_reset is fire-and-forget; use vi.waitFor to let the async settle
    await vi.waitFor(() => {
      expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1);
    });
    const [event, context] = hookRunnerMocks.runBeforeReset.mock.calls[0] ?? [];
    expect(event).toMatchObject({ reason: "daily" });
    expect(context).toMatchObject({ sessionKey, agentId: "main" });
  });

  it("does not fire hooks for system events even when session is stale", async () => {
    const sessionKey = "agent:main:telegram:direct:303";
    const storePath = await createStorePath("openclaw-system-event");
    const transcriptPath = await writeTranscript(storePath, "system-session");
    const yesterday = Date.now() - 48 * 60 * 60 * 1000;
    await writeStore(storePath, {
      [sessionKey]: {
        sessionId: "system-session",
        sessionFile: transcriptPath,
        updatedAt: yesterday,
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "heartbeat", SessionKey: sessionKey, Provider: "heartbeat" },
      cfg,
      commandAuthorized: true,
    });

    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(hookRunnerMocks.runBeforeReset).not.toHaveBeenCalled();
  });

  it("does not fire hooks on first-ever session (no previousSessionEntry)", async () => {
    const sessionKey = "agent:main:telegram:direct:404";
    const storePath = await createStorePath("openclaw-first-session");
    await writeStore(storePath, {});
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(hookRunnerMocks.runBeforeReset).not.toHaveBeenCalled();
  });
});
