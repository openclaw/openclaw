import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { withSessionManagerWrite } from "../agents/sessions/session-manager-write-admission.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("settles an accepted memory manager append before the real close retires its owner", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("incognito-manager-close");
  const release = createDeferredCore();
  const accepted = createDeferredCore();
  const joining = createDeferredCore();
  let actor: SessionActor | undefined;
  let writing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const owner = memorySessionActorOwners.get({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: fixture.state.env }),
    });
    const target = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-close",
      sessionId: "close",
      storePath: owner.path,
      env: fixture.state.env,
    };
    actor = await owner.acquire(
      { database: owner.identity, sessionKey: target.sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    expect(
      (
        await actor.storage!.mutate(
          {
            type: "session.entry.create",
            input: {
              entry: {
                sessionId: target.sessionId,
                lifecycleRevision: "initial",
                incognito: true,
                updatedAt: 1,
              },
            },
          },
          { assertCurrent() {}, authorize() {} },
        )
      ).kind,
    ).toBe("committed");
    const manager = await SessionManager.openAsync(target);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "incognito-manager-settlement",
      delayMs: 0,
      run() {
        writing = withSessionManagerWrite(manager, async () => {
          accepted.resolve();
          await release.promise;
          const id = await manager.appendMessageAsync(makeUserMessage("accepted before close", 1));
          expect(manager.getEntries()).toMatchObject([{ id, type: "message" }]);
          expect(manager.getEntries()).toHaveLength(1);
        }).catch((error: unknown) => {
          accepted.reject(error);
          throw error;
        });
        return writing;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await withinTest(accepted.promise, signal);
    const stop = kernel.scheduler.stop.bind(kernel.scheduler);
    vi.spyOn(kernel.scheduler, "stop").mockImplementation(() => {
      joining.resolve();
      return stop();
    });
    closing = server.close({ reason: "incognito manager close proof" });
    await withinTest(
      awaitGateBeforeSettlement(joining.promise, closing, "Gateway skipped manager settlement"),
      signal,
    );
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(() => actor?.assertReadable()).not.toThrow();
    const tooLate = vi.fn();
    await kernel.scheduler.schedule({ id: "late-manager-write", delayMs: 0, run: tooLate }).stop();
    expect(tooLate).not.toHaveBeenCalled();
    release.resolve();
    await withinTest(Promise.all([writing, closing]), signal);
    expect(() => actor?.assertReadable()).toThrow("closed");
    await expect(manager.appendCustomEntryAsync("too-late")).rejects.toThrow("closed");
  } finally {
    vi.useRealTimers();
    release.resolve();
    await Promise.allSettled([writing, closing]);
    vi.restoreAllMocks();
    await actor?.release();
    await fixture.cleanup();
  }
});
