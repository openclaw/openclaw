import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { TerminalSessionManager } from "./session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  makeFakePty,
} from "./session-manager.test-helpers.js";

describe("TerminalSessionManager agent session lifecycle", () => {
  it("drains one agent incarnation while admitting its same-key replacement", async () => {
    const oldPty = makeFakePty();
    const pendingPty = makeFakePty();
    const { promise: pendingBackend, resolve: resolvePending } =
      createDeferred<ReturnType<typeof makeFakePty>>();
    const replacementPtys = [makeFakePty(), makeFakePty()];
    let spawnIndex = 0;
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => replacementPtys[spawnIndex++] ?? makeFakePty(),
    });
    const oldOwner = agentTerminalOwner("agent:main:archive-target", "old-session");
    const replacementOwner = agentTerminalOwner("agent:main:archive-target", "replacement-session");
    const opened = await manager.open(
      baseOpenRequest({ owner: oldOwner, createBackend: async () => oldPty }),
    );
    if (!opened.ok) {
      throw new Error("expected terminal session");
    }
    const pending = manager.open(
      baseOpenRequest({ owner: oldOwner, createBackend: () => pendingBackend }),
    );

    const drain = manager.beginAgentSessionDrain(oldOwner);
    expect(oldPty.killed).toBe(true);
    expect(drain.hasWork()).toBe(true);
    resolvePending(pendingPty);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "closed" });
    expect(pendingPty.killed).toBe(true);
    expect(drain.hasWork()).toBe(true);
    oldPty.emitExit(0);
    expect(drain.hasWork()).toBe(true);
    pendingPty.emitExit(0);
    await expect(drain.drained).resolves.toBeUndefined();
    expect(drain.hasWork()).toBe(false);
    await expect(manager.open(baseOpenRequest({ owner: oldOwner }))).resolves.toMatchObject({
      ok: false,
      code: "closed",
    });
    await expect(manager.open(baseOpenRequest({ owner: replacementOwner }))).resolves.toMatchObject(
      {
        ok: true,
      },
    );

    drain.release();
    await expect(manager.open(baseOpenRequest({ owner: oldOwner }))).resolves.toMatchObject({
      ok: true,
    });
  });
});
