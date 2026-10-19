// Idle-eviction under pool pressure: one busy agent must not brick terminal
// opens gateway-wide until restart.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { TerminalSessionManager } from "./session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  expectTerminalOpen,
  type FakeTerminalPty,
  makeFakePty,
} from "./session-manager.test-helpers.js";

afterEach(() => vi.useRealTimers());

const agentOwner = agentTerminalOwner("agent:main:main");

function trackingManager(maxSessions: number, spawn = async () => makeFakePty()) {
  const ptys: FakeTerminalPty[] = [];
  const manager = new TerminalSessionManager({
    emit: vi.fn(),
    spawn: async () => {
      const pty = await spawn();
      ptys.push(pty);
      return pty;
    },
    maxSessions,
  });
  const open = (overrides: Parameters<typeof baseOpenRequest>[0] = {}) =>
    manager.open(baseOpenRequest({ owner: agentOwner, ...overrides }));
  return { manager, ptys, open };
}

describe("TerminalSessionManager idle eviction", () => {
  it("never evicts viewer-attached or connection-owned sessions under pressure", async () => {
    const { manager, ptys, open } = trackingManager(2);
    expectTerminalOpen(await manager.open(baseOpenRequest()));
    const viewed = expectTerminalOpen(await open());
    expect(manager.attach("viewer-1", viewed.sessionId)?.sessionId).toBe(viewed.sessionId);

    await expect(open()).resolves.toMatchObject({ ok: false, code: "limit" });
    expect(manager.size).toBe(2);
    expect(ptys.some((pty) => pty.killed)).toBe(false);
  });

  it("spares a victim that gains a viewer during the replacement spawn", async () => {
    const victimPty = makeFakePty();
    const replacementPty = makeFakePty();
    const gate = createDeferred();
    let spawnCount = 0;
    const { manager, open } = trackingManager(1, async () => {
      if (spawnCount++ === 0) {
        return victimPty;
      }
      await gate.promise;
      return replacementPty;
    });
    const victim = expectTerminalOpen(await open());

    const opening = open();
    // The replacement stays gated while the idle victim gains a viewer.
    expect(manager.attach("viewer-1", victim.sessionId)?.sessionId).toBe(victim.sessionId);
    gate.resolve();

    await expect(opening).resolves.toMatchObject({ ok: false, code: "limit" });
    expect(victimPty.killed).toBe(false);
    expect(replacementPty.killed).toBe(true);
    expect(manager.size).toBe(1);
    expect(manager.write("viewer-1", victim.sessionId, "still-alive\r")).toBe(true);
  });

  it("evicts the freshly idlest session when the oldest becomes active mid-spawn", async () => {
    vi.useFakeTimers();
    const gate = createDeferred();
    let gateNextSpawn = false;
    const { manager, ptys, open } = trackingManager(2, async () => {
      if (gateNextSpawn) {
        await gate.promise;
      }
      return makeFakePty();
    });
    expectTerminalOpen(await open());
    await vi.advanceTimersByTimeAsync(5_000);
    expectTerminalOpen(await open());

    gateNextSpawn = true;
    const opening = open();
    // The oldest session becomes active during the spawn, making
    // the newer session the genuinely idlest candidate.
    await vi.advanceTimersByTimeAsync(5_000);
    expectDefined(ptys[0], "oldest pty invariant").emitData("busy\n");
    gate.resolve();

    expectTerminalOpen(await opening);
    expect(manager.size).toBe(2);
    expect(expectDefined(ptys[0], "oldest pty invariant").killed).toBe(false);
    expect(expectDefined(ptys[1], "newer pty invariant").killed).toBe(true);
  });

  it("holds the cap when concurrent opens complete out of order", async () => {
    const gates: Array<(pty: FakeTerminalPty) => void> = [];
    const { manager, open } = trackingManager(
      2,
      () =>
        new Promise<FakeTerminalPty>((resolve) => {
          gates.push(resolve);
        }),
    );
    const seeded = open();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]?.(makeFakePty());
    expectTerminalOpen(await seeded);

    // A reserves the free slot; B sees the reservation and an idle eviction
    // candidate. B's spawn completes first.
    const openA = open();
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    const openB = open();
    await vi.waitFor(() => expect(gates).toHaveLength(3));
    const excess = open();
    expect(gates).toHaveLength(3);
    await expect(excess).resolves.toMatchObject({ ok: false, code: "limit" });
    gates[2]?.(makeFakePty());
    const outcomeB = await openB;
    gates[1]?.(makeFakePty());
    const outcomeA = await openA;

    expect([outcomeA.ok, outcomeB.ok]).toEqual([true, true]);
    expect(manager.size).toBeLessThanOrEqual(2);
  });

  it("allows idle eviction after a cancelled open's spawn never settles", async () => {
    let hangNextSpawn = false;
    const { manager, open } = trackingManager(1, async () => {
      if (hangNextSpawn) {
        hangNextSpawn = false;
        return await new Promise<never>(() => {});
      }
      return makeFakePty();
    });
    expectTerminalOpen(await open());
    hangNextSpawn = true;
    const controller = new AbortController();
    const hung = open({ signal: controller.signal });
    await vi.waitFor(() => expect(hangNextSpawn).toBe(false));
    controller.abort(new Error("cancelled"));

    expectTerminalOpen(await open());
    expect(manager.size).toBe(1);
    // The hung open stays pending forever by design; do not await it.
    void hung;
  });

  it("keeps the idle victim alive when the replacement spawn fails", async () => {
    const pty = makeFakePty();
    let failNextSpawn = false;
    const { manager, open } = trackingManager(1, async () => {
      if (failNextSpawn) {
        throw new Error("pty exhausted");
      }
      return pty;
    });
    const victim = expectTerminalOpen(await open());

    failNextSpawn = true;
    await expect(open()).resolves.toMatchObject({ ok: false, code: "spawn_failed" });
    expect(manager.size).toBe(1);
    expect(pty.killed).toBe(false);
    pty.emitData("still-alive\n");
    expect(manager.snapshotAgent(agentOwner, victim.sessionId)).toContain("still-alive");

    failNextSpawn = false;
    expectTerminalOpen(await open());
    expect(manager.size).toBe(1);
    expect(pty.killed).toBe(true);
  });
});
