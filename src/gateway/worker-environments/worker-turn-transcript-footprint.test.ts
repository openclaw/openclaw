import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { WorkerRunnerUnavailableError } from "./tunnel-contract.js";
import {
  expectWorkerFixtureCancellation,
  type WorkerFixtureCancellationProbe,
} from "./worker-turn-cancellation.test-support.js";
import * as fixture from "./worker-turn-launcher.test-support.js";

const INACTIVE_MARKER = "inactive fixture message ";
const INPUT_TEXT = "Inspect this workspace";

const isInactive = (message: unknown) =>
  JSON.stringify(message)?.includes(INACTIVE_MARKER) ?? false;

async function seedBranchedHistory(persistCurrentInput: boolean): Promise<number> {
  const manager = await SessionManager.openAsync(fixture.sessionTarget);
  const user = (content: string, timestamp: number) =>
    manager.appendMessageAsync(makeAgentUserMessage({ content, timestamp }));
  const assistant = (text: string, timestamp: number) =>
    manager.appendMessageAsync(
      makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp }),
    );
  const anchor = expectDefined(
    await user("Starting the conversation.", 1),
    "expected persisted branch anchor",
  );
  for (let index = 0; index < 64; index++) {
    const text = `${INACTIVE_MARKER}${index}`.padEnd(1024, ".");
    await (index % 2 === 0 ? user : assistant)(text, index + 2);
  }
  await manager.branchAsync(anchor);
  await user("Continue on the selected branch.", 66);
  await assistant("Selected branch is ready.", 67);
  if (persistCurrentInput) {
    await user(INPUT_TEXT, 68);
  }
  return persistCurrentInput ? 4 : 3;
}

describe("Gateway worker-turn selected transcript preparation", () => {
  let hasUnjoinedOwner = false;
  beforeEach(async () => {
    if (hasUnjoinedOwner) {
      throw new Error("Prior worker fixture remains unjoined; retained state must not be replaced");
    }
    await fixture.setupWorkerTurnLauncherTest();
  });
  afterEach(async () => {
    if (!hasUnjoinedOwner) {
      await fixture.cleanupWorkerTurnLauncherTest();
    }
  });

  async function checkSelectedTranscript(
    persistence: "already-persisted" | "recorder-owned",
    signal: AbortSignal,
    cancellation?: WorkerFixtureCancellationProbe,
  ) {
    const expectedMessages = await seedBranchedHistory(persistence === "already-persisted");
    await fixture.seedActivePlacement();
    const reachedCredential = createDeferredCore();
    const releaseCredential = createDeferredCore();
    const deliberateStop = new WorkerRunnerUnavailableError();
    const fixtureAbort = new AbortController();
    const recorder =
      persistence === "recorder-owned"
        ? createUserTurnTranscriptRecorder({
            target: { ...fixture.sessionTarget, sessionEntry: undefined },
            input: { text: INPUT_TEXT },
          })
        : undefined;
    const request = {
      ...fixture.turn(`selected-context-${persistence}`),
      prompt: INPUT_TEXT,
      ...(recorder
        ? { userTurnTranscriptRecorder: recorder }
        : { suppressNextUserMessagePersistence: true }),
      abortSignal: AbortSignal.any([fixtureAbort.signal, signal]),
    };
    const calls = { credential: 0, tunnel: 0, local: 0, destroy: 0, context: 0 };
    const environments: fixture.WorkerTurnEnvironmentService = {
      ...fixture.unusedEnvironments(),
      get: fixture.attachedEnvironment,
      acquireTurnCredential: async () => {
        calls.credential++;
        reachedCredential.resolve();
        await releaseCredential.promise;
        throw deliberateStop;
      },
      startTunnel: async () => {
        calls.tunnel++;
        throw new Error("Fixture must stop before tunnel creation");
      },
      destroy: async () => {
        calls.destroy++;
        throw new Error("Pre-launch refusal must preserve the active placement");
      },
    };
    const provider = fixture.createWorkerSessionTurnPlacementProvider({
      environments,
      placements: fixture.placements,
      ...(cancellation
        ? {
            resolveWorkspace: async () => {
              await cancellation.pause();
              return { kind: "local" as const, path: fixture.root };
            },
          }
        : {}),
    });
    let observation = {
      loadedMessages: 0,
      inactiveLoadedMessages: 0,
      contextMessages: 0,
      inactiveContextMessages: 0,
    };
    // Preserve the implementation to forward each observed manager as its explicit receiver.
    // oxlint-disable-next-line typescript/unbound-method
    const originalContext = SessionManager.prototype.buildSessionContext;
    const ownContextDescriptor = Object.getOwnPropertyDescriptor(
      SessionManager.prototype,
      "buildSessionContext",
    );
    // Observe loaded entries without retaining manager/results in mock histories.
    Object.defineProperty(SessionManager.prototype, "buildSessionContext", {
      configurable: true,
      writable: true,
      value(this: SessionManager) {
        const result = originalContext.call(this);
        const loaded = this.getEntries().filter((entry) => entry.type === "message");
        calls.context++;
        observation = {
          loadedMessages: loaded.length,
          inactiveLoadedMessages: loaded.filter((entry) => isInactive(entry.message)).length,
          contextMessages: result.messages.length,
          inactiveContextMessages: result.messages.filter(isInactive).length,
        };
        return result;
      },
    });
    hasUnjoinedOwner = true;
    const pending = provider
      .executeTurn(fixture.workerTurnRequest(request.runId), request, async () => {
        calls.local++;
        throw new Error("Fixture must use Gateway worker-turn orchestration");
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    let outcome: unknown;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          reachedCredential.promise,
          pending,
          "Turn settled before reaching credential acquisition",
        ),
        signal,
      );
      expect(calls).toEqual({ credential: 1, context: 1, tunnel: 0, local: 0, destroy: 0 });
      expect(observation).toEqual({
        contextMessages: expectedMessages,
        inactiveContextMessages: 0,
        loadedMessages: expectedMessages,
        inactiveLoadedMessages: 0,
      });
      if (recorder) {
        expect(recorder.hasPersisted()).toBe(false);
        expect(recorder.getAdmissionReceipt()).toBeUndefined();
      }
    } finally {
      cancellation?.onCleanup();
      releaseCredential.resolve();
      fixtureAbort.abort(deliberateStop);
      outcome = await pending;
      hasUnjoinedOwner = false;
      try {
        request.preparedRunAdmission.close();
      } finally {
        if (ownContextDescriptor) {
          Object.defineProperty(
            SessionManager.prototype,
            "buildSessionContext",
            ownContextDescriptor,
          );
        } else {
          delete (SessionManager.prototype as Partial<SessionManager>).buildSessionContext;
        }
      }
    }
    expect(outcome).toBe(deliberateStop);
    expect(fixture.placements.get(fixture.SESSION_ID)).toMatchObject({
      state: "active",
      turnClaim: null,
    });
    expect(await fixture.placements.listPendingWorkspaceResultsAsync()).toHaveLength(0);
    expect(calls.destroy).toBe(0);
  }

  it("joins a cancelled precredential fixture before replacing retained state", async ({
    signal,
  }) => {
    const originalContext = Object.getOwnPropertyDescriptor(
      SessionManager.prototype,
      "buildSessionContext",
    );
    await expectWorkerFixtureCancellation(
      (testSignal, cancellation) =>
        checkSelectedTranscript("already-persisted", testSignal, cancellation),
      signal,
    );
    expect(hasUnjoinedOwner).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(SessionManager.prototype, "buildSessionContext"),
    ).toEqual(originalContext);
    expect(fixture.placements.get(fixture.SESSION_ID)).toMatchObject({
      state: "active",
      turnClaim: null,
    });
  });

  it.for(["already-persisted", "recorder-owned"] as const)(
    "does not hydrate inactive branches for %s input",
    async (persistence, { signal }) => checkSelectedTranscript(persistence, signal),
  );
});
