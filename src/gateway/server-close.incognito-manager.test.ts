import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { withSessionManagerIncognitoActor } from "../agents/sessions/session-manager-incognito-scope.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { createDeferredCore } from "../shared/deferred.js";
import { IncognitoSessionEndedError } from "../state/incognito-session-error.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("settles accepted actor appends across the real close prelude before closing the actor", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("incognito-manager-close");
  const release = createDeferredCore();
  let held: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const authority = { assertCurrent() {} };
    const actor = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "main",
      env: fixture.state.env,
      authority,
    });
    assert(actor);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-close",
      sessionId: "close",
      storePath: actor.path,
      env: fixture.state.env,
    };
    await actor.sessions.create(authority, {
      sessionKey: target.sessionKey,
      entry: {
        sessionId: target.sessionId,
        lifecycleRevision: "initial",
        incognito: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
    const manager = await withSessionManagerIncognitoActor(actor, () =>
      SessionManager.openAsync(target),
    );
    const actorEntered = createDeferredCore();
    held = actor.run(authority, async () => {
      actorEntered.resolve();
      await release.promise;
    });
    await withinTest(actorEntered.promise, signal);
    const accepted = createDeferredCore();
    const prelude = createDeferredCore();
    const verified = createDeferredCore();
    kernel.scheduler.signal.addEventListener("abort", () => prelude.resolve(), { once: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "incognito-manager-settlement",
      delayMs: 0,
      run: () =>
        withSessionManagerIncognitoActor(
          actor,
          async () => {
            const writing = manager.appendMessageAsync(makeUserMessage("accepted before close", 1));
            accepted.resolve();
            await prelude.promise;
            const tooLate = manager.appendCustomEntryAsync("too-late");
            release.resolve();
            await expect(tooLate).rejects.toThrow();
            const id = await writing;
            await expect(SessionManager.openAsync(target)).rejects.toThrow();
            expect(manager.getEntries()).toMatchObject([{ id, type: "message" }]);
            expect(manager.getEntries()).toHaveLength(1);
            verified.resolve();
          },
          kernel.scheduler.signal,
        ).catch((error: unknown) => {
          verified.reject(error);
          throw error;
        }),
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await withinTest(accepted.promise, signal);
    closing = server.close({ reason: "incognito manager close proof" });
    await withinTest(verified.promise, signal);
    await closing;
    expect(() => actor.assertCurrent()).toThrow(IncognitoSessionEndedError);
  } finally {
    vi.useRealTimers();
    release.resolve();
    await Promise.allSettled([held, closing]);
    await fixture.cleanup();
  }
});
