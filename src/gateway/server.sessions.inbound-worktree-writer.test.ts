import fs from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { captureMethodCall } from "../../test/helpers/capture-method-call.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { managedWorktrees, ManagedWorktreeService } from "../agents/worktrees/service.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { isSessionLifecycleMutationActive } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import {
  directSessionReq,
  loadSeededTranscriptEvents,
} from "./test/server-sessions.test-helpers.js";
import { setupGatewaySessionsWorktreeTestHarness } from "./test/server-sessions.worktree-fixture.js";

const { createArchiveWorktreeFixture } = setupGatewaySessionsWorktreeTestHarness();

test.for([false, true])(
  "inbound restore releases unrelated session writes while allocation waits (checkout already restored=%s)",
  async (alreadyRestored, { signal }) => {
    const fixture = await createArchiveWorktreeFixture();
    const { key, sessionId, storePath, worktree, workspace } = fixture;
    const peer = await directSessionReq<{ key: string }>("sessions.create", { agentId: "main" });
    expect(peer.ok).toBe(true);
    const peerKey = peer.payload!.key;
    expect(peerKey).toMatch(/^agent:main:/);
    expect(loadSessionEntry({ storePath, sessionKey: peerKey })).toBeDefined();
    await fs.writeFile(path.join(worktree.path, "draft.txt"), "inbound restore preserves work\n");
    expect(
      await directSessionReq("sessions.patch", {
        key,
        expectedSessionId: sessionId,
        archived: true,
      }),
    ).toMatchObject({ ok: true });
    await fixture.cleanupWorktrees();
    if (alreadyRestored) {
      await managedWorktrees.restore({ id: worktree.id });
    }
    const [
      { createDispatchReplyOperationCoordinator },
      { createReplyDispatcher },
      { buildTestCtx },
    ] = await Promise.all([
      import("../auto-reply/reply/dispatch-from-config.lifecycle.js"),
      import("../auto-reply/reply/reply-dispatcher.js"),
      import("../auto-reply/reply/test-ctx.js"),
    ]);
    const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
    const dispatcher = createReplyDispatcher({ deliver: async () => {} });
    onTestFinished(async () => {
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    });
    const coordinator = createDispatchReplyOperationCoordinator({
      agentId: "main",
      cfg: { agents: { defaults: { workspace } } },
      ctx: buildTestCtx({
        SessionKey: key,
        Body: "Continue this task",
        CommandSource: undefined,
        InboundAccessAuthorized: true,
        InboundEventKind: "user_request",
        InputProvenance: { kind: "external_user", sourceChannel: "discord" },
      }),
      dispatcher,
      dispatchOperationSessionKey: key,
      operationSessionStoreEntry: {
        storePath,
        entry: loadSessionEntry({ storePath, sessionKey: key }),
      },
      sessionWorkerPlacementContext: {},
      resolveOperationExpectedSessionId: () => sessionId,
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const restoreEntered = createDeferredCore();
    const allocation = withOpenClawStateLease(
      {
        scope: "core:managed-worktrees:create",
        key: "capacity",
        database: { scope: "shared" },
        leaseMs: 60_000,
        waitMs: 5_000,
      },
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    const originalRestore = captureMethodCall("restore")(ManagedWorktreeService.prototype);
    const restore = vi
      .spyOn(ManagedWorktreeService.prototype, "restore")
      .mockImplementation(function (this: ManagedWorktreeService, params) {
        restoreEntered.resolve();
        return originalRestore(this, params);
      });
    let admission: ReturnType<typeof coordinator.ensureDispatchReplyOperation> | undefined;
    let independent: ReturnType<typeof directSessionReq> | undefined;
    let admissionDone = false;
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, allocation, "allocation lease was not acquired"),
        signal,
      );
      admission = coordinator.ensureDispatchReplyOperation("pre_dispatch").then((result) => {
        admissionDone = true;
        return result;
      });
      if (alreadyRestored) {
        await expect(withinTest(admission, signal)).resolves.toEqual({ status: "ready" });
        expect(restore).not.toHaveBeenCalled();
      } else {
        await withinTest(
          awaitGateBeforeSettlement(restoreEntered.promise, admission, "restore was not attempted"),
          signal,
        );
        expect(restore).toHaveBeenCalledOnce();
        expect(isSessionLifecycleMutationActive(storePath, [key, sessionId])).toBe(true);
      }
      independent = directSessionReq("sessions.patch", {
        key: peerKey,
        label: "Independent inbound peer",
      });
      // Test cancellation reaches finally even if the writer blocks behind the allocation lease.
      expect(await withinTest(independent, signal)).toMatchObject({ ok: true });
      if (!alreadyRestored) {
        expect(admissionDone).toBe(false);
        expect(isSessionLifecycleMutationActive(storePath, [key, sessionId])).toBe(true);
        expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toEqual(
          expect.any(Number),
        );
        await expect(fs.access(worktree.path)).rejects.toThrow();
      }
    } finally {
      release.resolve();
      await Promise.allSettled([allocation, admission, independent]);
      restore.mockRestore();
      coordinator.completeDispatchReplyOperation();
      await coordinator.releasePreDispatchLifecycleAdmission();
    }
    await allocation;
    await expect(admission).resolves.toEqual({ status: "ready" });
    expect(loadSessionEntry({ storePath, sessionKey: peerKey })?.label).toBe(
      "Independent inbound peer",
    );
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
    await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
      "inbound restore preserves work\n",
    );
    await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(transcript);
  },
);
