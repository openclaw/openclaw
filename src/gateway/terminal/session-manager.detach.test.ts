import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeTerminalIntroBanner } from "./intro-banner.js";
import { TerminalSessionManager } from "./session-manager.js";
import {
  baseOpenRequest as baseRequest,
  expectTerminalOpen,
  makeFakePty,
} from "./session-manager.test-helpers.js";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const OPERATOR_INTRO = composeTerminalIntroBanner();

type ManagerOptions = Partial<ConstructorParameters<typeof TerminalSessionManager>[0]>;
describe("TerminalSessionManager detach/reattach", () => {
  async function openDetachable(options: ManagerOptions = {}, title?: string) {
    const emit = vi.fn();
    const fake = makeFakePty();
    const ptys = [fake, makeFakePty()];
    let spawned = 0;
    const manager = new TerminalSessionManager({
      emit,
      detachGraceMs: 60_000,
      spawn: async () => expectDefined(ptys[spawned++], "PTY"),
      ...options,
    });
    const open = async (connId = "conn-1") =>
      expectTerminalOpen(
        await manager.open(baseRequest({ owner: { kind: "conn", connId }, title })),
      );
    const { sessionId } = await open();
    return { manager, fake, ptys, emit, sessionId, open };
  }

  it.each([0, 10_000, "shutdown"] as const)("clears detached sessions after %s", async (grace) => {
    const { manager, fake, sessionId } = await openDetachable({ detachGraceMs: 20_000 });
    manager.handleDisconnect("conn-1");
    if (grace === "shutdown") {
      manager.disposeAll();
    } else {
      vi.advanceTimersByTime(5_000);
      manager.updateDetachGraceMs(grace);
      if (grace > 5_000) {
        vi.advanceTimersByTime(grace - 5_001);
        expect(fake.killed).toBe(false);
        vi.advanceTimersByTime(1);
      }
    }
    expect(fake.killed).toBe(true);
    expect(manager.size).toBe(0);
    expect(manager.attach("conn-2", sessionId)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves attached sessions and uses the new timeout on their next disconnect", async () => {
    const { manager, fake, sessionId } = await openDetachable();
    manager.updateDetachGraceMs(10_000);
    vi.advanceTimersByTime(60_000);
    expect(fake.killed).toBe(false);

    manager.handleDisconnect("conn-1");
    vi.advanceTimersByTime(5_000);
    expect(manager.attach("conn-2", sessionId)).toBeDefined();
    manager.updateDetachGraceMs(0);
    vi.advanceTimersByTime(60_000);
    expect(manager.write("conn-2", sessionId, "still attached")).toBe(true);
    expect(fake.killed).toBe(false);
    manager.handleDisconnect("conn-2");
    expect(fake.killed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("attach rebinds a detached session, replays the buffer, and resumes streaming", async () => {
    const { manager, fake, emit, sessionId } = await openDetachable({}, "codex");
    fake.emitData("before ");
    manager.handleDisconnect("conn-1");
    fake.emitData("away ");
    emit.mockClear();

    expect(manager.attach("conn-2", sessionId)).toMatchObject({
      buffer: `${OPERATOR_INTRO}before away `,
      seq: OPERATOR_INTRO.length + 12,
      agentId: "main",
      title: "codex",
      owner: "conn",
    });
    expect(manager.list()).toEqual([
      expect.objectContaining({ sessionId, title: "codex", owner: "conn" }),
    ]);
    vi.advanceTimersByTime(120_000);
    expect(fake.killed).toBe(false);

    fake.emitData("live");
    await vi.advanceTimersByTimeAsync(4);
    expect(emit).toHaveBeenCalledWith("conn-2", "terminal.data", {
      sessionId,
      seq: OPERATOR_INTRO.length + 16,
      data: "live",
    });
    expect(manager.write("conn-2", sessionId, "ls\n")).toBe(true);
    expect(manager.write("conn-1", sessionId, "ls\n")).toBe(false);
    expect(fake.writes).toEqual(["ls\n"]);
  });

  it("attach takes over a live session and notifies the previous owner", async () => {
    const { manager, fake, emit, sessionId } = await openDetachable();
    emit.mockClear();
    expect(manager.attach("conn-2", sessionId)?.sessionId).toBe(sessionId);
    expect(emit).toHaveBeenCalledWith("conn-1", "terminal.exit", {
      sessionId,
      exitCode: null,
      signal: null,
      reason: "detached",
    });
    emit.mockClear();
    fake.emitData("output");
    await vi.advanceTimersByTimeAsync(4);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toBe("conn-2");
    // The old owner's disconnect later must not tear down the stolen session.
    manager.handleDisconnect("conn-1");
    expect(manager.size).toBe(1);
    expect(manager.write("conn-2", sessionId, "x")).toBe(true);
  });

  it("caps detached sessions by killing the oldest", async () => {
    const { manager, ptys, open } = await openDetachable({ maxDetachedSessions: 1 });
    await open("conn-2");
    manager.handleDisconnect("conn-1");
    vi.advanceTimersByTime(1);
    manager.handleDisconnect("conn-2");
    expect(ptys).toMatchObject([{ killed: true }, { killed: false }]);
    expect(manager.size).toBe(1);
  });

  it("lists sessions with attachment state, oldest first", async () => {
    const { manager, sessionId, open } = await openDetachable();
    vi.advanceTimersByTime(5);
    const second = await open("conn-2");
    manager.handleDisconnect("conn-2");
    const listed = manager.list();
    expect(listed.map((s) => s.sessionId)).toEqual([sessionId, second.sessionId]);
    expect(listed[0]).toMatchObject({ attached: true, agentId: "main", shell: "/bin/zsh" });
    expect(listed[1]).toMatchObject({ attached: false });
    expect(expectDefined(listed[1], "second session").createdAtMs).toBeGreaterThan(
      expectDefined(listed[0], "first session").createdAtMs,
    );
  });
});
