import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { HookRunner } from "../../plugins/hooks.js";

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runSessionStart: vi.fn<HookRunner["runSessionStart"]>(),
  runSessionEnd: vi.fn<HookRunner["runSessionEnd"]>(),
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

describe("session hook context wiring", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../../plugins/hook-runner-global.js", () => ({
      getGlobalHookRunner: () =>
        ({
          hasHooks: hookRunnerMocks.hasHooks,
          runSessionStart: hookRunnerMocks.runSessionStart,
          runSessionEnd: hookRunnerMocks.runSessionEnd,
        }) as unknown as HookRunner,
    }));
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runSessionStart.mockReset();
    hookRunnerMocks.runSessionEnd.mockReset();
    hookRunnerMocks.runSessionStart.mockResolvedValue(undefined);
    hookRunnerMocks.runSessionEnd.mockResolvedValue(undefined);
    hookRunnerMocks.hasHooks.mockImplementation(
      (hookName) => hookName === "session_start" || hookName === "session_end",
    );
    ({ initSessionState } = await import("./session.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes sessionKey to session_start hook context", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    const storePath = await createStorePath("openclaw-session-hook-start");
    await writeStore(storePath, {});
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1));
    const [event, context] = hookRunnerMocks.runSessionStart.mock.calls[0] ?? [];
    expect(event).toMatchObject({ sessionKey });
    expect(context).toMatchObject({ sessionKey, agentId: "main" });
    expect(context).toMatchObject({ sessionId: event?.sessionId });
  });

  it("passes sessionKey to session_end hook context on reset", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    const storePath = await createStorePath("openclaw-session-hook-end");
    await writeStore(storePath, {
      [sessionKey]: {
        sessionId: "old-session",
        updatedAt: Date.now(),
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await initSessionState({
      ctx: { Body: "/new", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runSessionEnd).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(hookRunnerMocks.runSessionStart).toHaveBeenCalledTimes(1));
    const [event, context] = hookRunnerMocks.runSessionEnd.mock.calls[0] ?? [];
    expect(event).toMatchObject({ sessionKey });
    expect(context).toMatchObject({ sessionKey, agentId: "main" });
    expect(context).toMatchObject({ sessionId: event?.sessionId });

    const [startEvent] = hookRunnerMocks.runSessionStart.mock.calls[0] ?? [];
    expect(startEvent).toMatchObject({ resumedFrom: "old-session" });
  });
});
