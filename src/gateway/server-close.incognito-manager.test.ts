import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { withSessionManagerWrite } from "../agents/sessions/session-manager-write-admission.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";

it("settles an accepted memory manager append before the real close retires its owner", async ({
  signal,
}) => {
  const race = await createGatewayCloseRace("incognito-manager-close", signal);
  const { fixture, kernel } = race;
  const joining = new AbortController();
  let actor: SessionActor | undefined;
  let writing: Promise<void> | undefined;
  try {
    const owner = memorySessionActorOwners.get({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: fixture.state.env }),
    });
    const entry = {
      sessionId: "close",
      lifecycleRevision: "r",
      incognito: true,
      updatedAt: 1,
    } satisfies InternalSessionEntry;
    const target = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-close",
      sessionId: entry.sessionId,
      storePath: owner.path,
      env: fixture.state.env,
    };
    actor = await owner.acquire(
      { database: owner.identity, sessionKey: target.sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    const created = await actor.storage!.mutate(
      { type: "session.entry.create", input: { entry } },
      { assertCurrent() {}, authorize() {} },
    );
    expect(created.kind).toBe("committed");
    const manager = await SessionManager.openAsync(target);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "incognito-manager-settlement",
      delayMs: 0,
      run() {
        writing = withSessionManagerWrite(manager, async () => {
          await race.block();
          const id = await manager.appendMessageAsync(makeUserMessage("accepted before close", 1));
          expect(manager.getEntries()).toEqual([expect.objectContaining({ id, type: "message" })]);
        });
        return writing;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await race.waitForEntry(writing);
    const stop = kernel.scheduler.stop.bind(kernel.scheduler);
    vi.spyOn(kernel.scheduler, "stop").mockImplementation(() => {
      joining.abort();
      return stop();
    });
    await race.close(joining.signal, undefined, { reason: "incognito manager close proof" });
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(() => actor?.assertReadable()).not.toThrow();
    const tooLate = vi.fn();
    await kernel.scheduler.schedule({ id: "late-manager-write", delayMs: 0, run: tooLate }).stop();
    expect(tooLate).not.toHaveBeenCalled();
    await race.finish(writing);
    expect(() => actor?.assertReadable()).toThrow("closed");
    await expect(manager.appendCustomEntryAsync("too-late")).rejects.toThrow("closed");
  } finally {
    vi.useRealTimers();
    race.onCleanup(async () => {
      await Promise.allSettled([writing]);
      vi.restoreAllMocks();
      await actor?.release();
    });
    await race.dispose();
  }
});
