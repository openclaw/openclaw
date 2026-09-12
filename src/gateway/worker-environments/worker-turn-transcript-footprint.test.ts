import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { WorkerRunnerUnavailableError } from "./tunnel-contract.js";
import {
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  root as fixtureRoot,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

const INACTIVE_MARKER = "inactive fixture message ";
const INPUT_TEXT = "Inspect this workspace";

function textOf(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .map((part: unknown) =>
          part && typeof part === "object" && "text" in part && typeof part.text === "string"
            ? part.text
            : "",
        )
        .join("")
    : "";
}

function seedBranchedHistory(persistCurrentInput: boolean): number {
  const manager = SessionManager.open(sessionTarget);
  const anchor = manager.appendMessage(
    makeAgentUserMessage({ content: "Starting the conversation.", timestamp: 1 }),
  );
  for (let index = 0; index < 64; index++) {
    const text = `${INACTIVE_MARKER}${index}`.padEnd(1024, ".");
    manager.appendMessage(
      index % 2 === 0
        ? makeAgentUserMessage({ content: text, timestamp: index + 2 })
        : makeAgentAssistantMessage({
            content: [{ type: "text", text }],
            timestamp: index + 2,
          }),
    );
  }
  manager.branch(anchor);
  manager.appendMessage(
    makeAgentUserMessage({ content: "Continue on the selected branch.", timestamp: 66 }),
  );
  manager.appendMessage(
    makeAgentAssistantMessage({
      content: [{ type: "text", text: "Selected branch is ready." }],
      timestamp: 67,
    }),
  );
  if (persistCurrentInput) {
    manager.appendMessage(makeAgentUserMessage({ content: INPUT_TEXT, timestamp: 68 }));
  }
  return persistCurrentInput ? 4 : 3;
}

describe("Gateway worker-turn selected transcript preparation", () => {
  let hasUnjoinedOwner = false;
  beforeEach(async () => {
    if (hasUnjoinedOwner) {
      throw new Error("Prior worker fixture remains unjoined; retained state must not be replaced");
    }
    await setupWorkerTurnLauncherTest();
  });
  afterEach(async () => {
    if (!hasUnjoinedOwner) {
      await cleanupWorkerTurnLauncherTest();
    }
  });

  it.each(["already-persisted", "recorder-owned"] as const)(
    "does not hydrate inactive branches for %s input",
    async (persistence) => {
      const expectedMessages = seedBranchedHistory(persistence === "already-persisted");
      seedActivePlacement();
      const reachedCredential = createDeferredCore();
      const releaseCredential = createDeferredCore();
      const deliberateStop = new WorkerRunnerUnavailableError();
      const fixtureAbort = new AbortController();
      const recorder =
        persistence === "recorder-owned"
          ? createUserTurnTranscriptRecorder({
              target: { ...sessionTarget, sessionEntry: undefined },
              input: { text: INPUT_TEXT },
            })
          : undefined;
      const request = {
        ...turn(`selected-context-${persistence}`),
        prompt: INPUT_TEXT,
        ...(recorder
          ? { userTurnTranscriptRecorder: recorder }
          : { suppressNextUserMessagePersistence: true }),
        abortSignal: fixtureAbort.signal,
      };
      let credentialCalls = 0;
      let tunnelCalls = 0;
      let localCalls = 0;
      let destroyCalls = 0;
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: () => attachedEnvironment(),
        acquireTurnCredential: async () => {
          credentialCalls++;
          reachedCredential.resolve();
          await releaseCredential.promise;
          throw deliberateStop;
        },
        startTunnel: async () => {
          tunnelCalls++;
          throw new Error("Fixture must stop before tunnel creation");
        },
        destroy: async () => {
          destroyCalls++;
          throw new Error("Pre-launch refusal must preserve the active placement");
        },
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      let contextCalls = 0;
      let observation:
        | {
            loadedMessages: number;
            inactiveLoadedMessages: number;
            contextMessages: number;
            inactiveContextMessages: number;
          }
        | undefined;
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
          contextCalls++;
          observation = {
            loadedMessages: loaded.length,
            inactiveLoadedMessages: loaded.filter((entry) =>
              textOf(entry.message).startsWith(INACTIVE_MARKER),
            ).length,
            contextMessages: result.messages.length,
            inactiveContextMessages: result.messages.filter((message) =>
              textOf(message).startsWith(INACTIVE_MARKER),
            ).length,
          };
          return result;
        },
      });
      const pending = provider
        .executeTurn(
          { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: request.runId },
          request,
          async () => {
            localCalls++;
            throw new Error("Fixture must use Gateway worker-turn orchestration");
          },
        )
        .then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
      const failures: unknown[] = [];
      let outcome: Awaited<typeof pending> | undefined;
      try {
        await withTimeout(
          Promise.race([
            reachedCredential.promise,
            pending.then(() => {
              throw new Error("Turn settled before reaching credential acquisition");
            }),
          ]),
          request.timeoutMs,
          "worker transcript preparation",
        );
        expect(contextCalls).toBe(1);
        expect(observation?.contextMessages).toBe(expectedMessages);
        expect(observation?.inactiveContextMessages).toBe(0);
        expect(credentialCalls).toBe(1);
        expect(tunnelCalls).toBe(0);
        expect(localCalls).toBe(0);
        if (recorder) {
          expect(recorder.hasPersisted()).toBe(true);
          expect(recorder.getAdmissionReceipt()?.entryId).toEqual(expect.any(String));
        }
        expect(observation?.inactiveLoadedMessages).toBe(0);
        expect(observation?.loadedMessages).toBe(expectedMessages);
      } catch (error) {
        failures.push(error);
      } finally {
        releaseCredential.resolve();
        fixtureAbort.abort(deliberateStop);
        try {
          outcome = await withTimeout(pending, request.timeoutMs, "worker preparation owner join");
        } catch (error) {
          hasUnjoinedOwner = true;
          failures.push(
            new Error(`Unjoined worker fixture retained at ${fixtureRoot}`, { cause: error }),
          );
        } finally {
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
      }
      try {
        expect(outcome?.kind).toBe("rejected");
        if (outcome?.kind === "rejected") {
          expect(outcome.error).toBe(deliberateStop);
        }
        if (outcome) {
          expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
          expect(placements.listPendingWorkspaceResults()).toHaveLength(0);
        }
        expect(destroyCalls).toBe(0);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Worker selected-transcript preparation failed");
      }
    },
  );
});
