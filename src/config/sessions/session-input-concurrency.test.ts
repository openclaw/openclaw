import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { runOutsideStoreWriterContext } from "../../shared/store-writer-queue.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { listSessionPendingInputs } from "./session-accessor.pending-inputs.js";
import { patchSessionEntryCore, replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import * as actorScope from "./session-actor-scope.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import { acquireSessionInputActor, bindUserTurnInputActor } from "./session-input-actor.js";
import { recordSessionParticipantInWorker } from "./session-sharing-store.async.js";

async function acquireInput(
  target: Parameters<typeof acquireSessionInputActor>[0],
  assertCurrent = () => {},
) {
  return expectDefined(
    await acquireSessionInputActor(target, { assertCurrent, assertReadable: assertCurrent }),
    "admitted input actor",
  );
}

function recorderFor(
  f: ReturnType<typeof createSessionCompoundWorkerFixture>,
  text: string,
  idempotencyKey: string,
  overrides: Partial<Parameters<typeof createUserTurnTranscriptRecorder>[0]> = {},
) {
  return createUserTurnTranscriptRecorder({
    input: { text, idempotencyKey },
    target: overrides.target ?? {
      ...f.scope,
      expectedSessionId: f.scope.sessionId,
      sessionEntry: f.read(),
    },
    updateMode: "none",
    ...overrides,
  });
}

it("acquires a captured input actor outside unrelated writer work and checks authority before writing", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const f = createSessionCompoundWorkerFixture();
    const warmed = await acquireInput({ ...f.scope, target: f.target });
    await warmed.actor.release();
    const readSource = captureSessionEntryReadSource(f.database, undefined);
    const entered = createDeferred();
    const release = createDeferred();
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("Input authority revoked while waiting for the writer");
      }
    };
    const heldWriter = runOpenClawAgentWriteAdmission(
      { agentId: f.scope.agentId, path: f.database.path },
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    let input: Awaited<ReturnType<typeof acquireSessionInputActor>>;
    let acquiring: ReturnType<typeof acquireSessionInputActor> | undefined;
    let write: Promise<unknown> | undefined;
    try {
      await withinTest(entered.promise, signal);
      acquiring = acquireSessionInputActor(
        { ...f.scope, target: f.target, readSource },
        { assertCurrent, assertReadable: assertCurrent },
      );
      input = expectDefined(await withinTest(acquiring, signal), "captured input actor");
      const recorder = recorderFor(f, "Retain authority at the actual write", "captured-input", {
        onPersistenceError() {},
      });
      bindUserTurnInputActor(recorder, { phase: "acceptInput", acquire: async () => input });
      write = recorder.persistApproved();
      void write.catch(() => {});
      expect(f.events()).toEqual([]);
      current = false;
      release.resolve();
      await expect(write).rejects.toThrow("Input authority revoked while waiting for the writer");
      expect(f.events()).toEqual([]);
    } finally {
      release.resolve();
      await heldWriter;
      await Promise.allSettled(write ? [write] : []);
      input ??= await acquiring;
      await input?.actor.release();
    }
  });
});

it("accepts input through a captured path alias using the native owner's canonical identity", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const f = createSessionCompoundWorkerFixture();
    const alias = path.join(path.dirname(f.database.path), "input-alias");
    fs.symlinkSync(
      path.dirname(f.database.path),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliasPath = path.join(alias, path.basename(f.database.path));
    const input = await acquireInput({
      ...f.scope,
      storePath: aliasPath,
      target: f.target,
      readSource: { ...captureSessionEntryReadSource(f.database, undefined), path: aliasPath },
    });
    const recorder = recorderFor(f, "Accept through the original native owner", "aliased-input", {
      target: {
        ...f.scope,
        storePath: aliasPath,
        expectedSessionId: f.scope.sessionId,
        sessionEntry: f.read(),
      },
    });
    bindUserTurnInputActor(recorder, { phase: "acceptInput", acquire: async () => input });
    try {
      await expect(recorder.persistApproved()).resolves.toMatchObject({ appended: true });
      expect(f.events()).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ content: "Accept through the original native owner" }),
        }),
      );
    } finally {
      await input.actor.release();
    }
  });
});

it.each(["before", "after"] as const)(
  "checks input staging lifecycle changes %s writer admission",
  async (timing) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const f = createSessionCompoundWorkerFixture();
      const input = await acquireInput({ ...f.scope, target: f.target });
      const recorder = recorderFor(f, "Continue after the previous run", "next-input");
      bindUserTurnInputActor(recorder, { phase: "acceptInput", acquire: async () => input });
      const completePrevious = () =>
        patchSessionEntryCore(f.scope, () => ({ restartRecoveryTerminalRunIds: ["previous-run"] }));
      const run = actorScope.runSessionActorCommand;
      const accept = input.actor.acceptInput;
      const competingWrite =
        timing === "before"
          ? vi
              .spyOn(actorScope, "runSessionActorCommand")
              .mockImplementationOnce(async (...args) => {
                // A preceding terminal write owns the FIFO before this input joins it.
                const completed = runOutsideStoreWriterContext(() =>
                  runOpenClawAgentWriteAdmission(
                    { agentId: "main", path: f.database.path },
                    completePrevious,
                  ),
                );
                try {
                  return await run(...args);
                } finally {
                  await completed;
                }
              })
          : vi.spyOn(input.actor, "acceptInput").mockImplementationOnce(async (...args) => {
              await completePrevious();
              const outcome = await accept(...args);
              expect(outcome.kind).toBe("stale-version");
              return outcome;
            });
      try {
        const staged = recorder.stageApproved?.({ runId: "next-run", assertCurrent() {} });
        if (timing === "before") {
          await expect(staged).resolves.toBe(true);
          bindUserTurnInputActor(recorder, { phase: "adoptRun", acquire: async () => input });
          await expect(recorder.persistApproved()).resolves.toMatchObject({ appended: true });
          expect(f.events()).toContainEqual(
            expect.objectContaining({
              message: expect.objectContaining({ content: "Continue after the previous run" }),
            }),
          );
        } else {
          await expect(staged).rejects.toThrow(
            /^Session actor (?:version changed before command admission|lifecycle changed before its durable phase)$/,
          );
          expect(f.events()).toEqual([]);
        }
        expect(await listSessionPendingInputs(f.scope)).toEqual({ items: [], total: 0 });
      } finally {
        competingWrite.mockRestore();
        recorder.finishPendingInput?.("interrupted");
        await recorder.waitForPendingInputSettlement?.();
        await input.actor.release();
      }
    });
  },
);

it.each(["stage", "acceptInput", "adoptRun"] as const)(
  "persists concurrent initial inputs exactly once with participant writes queued around %s admission",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, async (_, index) => {
          const scope = {
            agentId: "main",
            storePath: database.path,
            sessionKey: `agent:main:concurrent-${index}`,
            sessionId: `concurrent-${index}`,
          };
          const entry = { sessionId: scope.sessionId, updatedAt: 1 };
          await replaceSessionEntry(scope, entry);
          const input = await acquireInput({
            ...scope,
            target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
          });
          const message = {
            role: "user" as const,
            content: `Initial input ${index}`,
            timestamp: 1,
            idempotencyKey: `concurrent-${index}:user`,
          };
          const recorder = createUserTurnTranscriptRecorder({
            message,
            target: { ...scope, expectedSessionId: scope.sessionId, sessionEntry: entry },
            updateMode: "none",
          });
          bindUserTurnInputActor(recorder, { phase: "acceptInput", acquire: async () => input });
          const recordParticipant = () =>
            recordSessionParticipantInWorker(scope, {
              identity: {
                type: "observation",
                pluginId: null,
                accountId: null,
                senderKind: "unknown",
                id: "gateway-client",
              },
              promptedAt: 1,
              sessionAgentId: scope.agentId,
            });
          let participantSettlement: Promise<unknown> | undefined;
          const admitAfterParticipant = async <T>(command: () => Promise<T>) => {
            await recordParticipant();
            const pending = command();
            // An independent request is already queued when the stale reply arrives.
            participantSettlement = runOutsideStoreWriterContext(recordParticipant);
            return pending;
          };
          if (phase === "adoptRun") {
            const adopt = input.actor.adoptRun;
            vi.spyOn(input.actor, "adoptRun").mockImplementationOnce((...args) =>
              admitAfterParticipant(() => adopt(...args)),
            );
          } else {
            const accept = input.actor.acceptInput;
            vi.spyOn(input.actor, "acceptInput").mockImplementationOnce((...args) =>
              admitAfterParticipant(() => accept(...args)),
            );
          }
          try {
            if (phase !== "acceptInput") {
              await expect(
                recorder.stageApproved?.({ runId: `run-${index}`, assertCurrent() {} }),
              ).resolves.toBe(true);
              bindUserTurnInputActor(recorder, { phase: "adoptRun", acquire: async () => input });
            }
            await expect(recorder.persistApproved()).resolves.toMatchObject({ appended: true });
            await recorder.persistFallback();
            expect(
              readTranscriptEventRows(database, scope.sessionId)
                .map((row) => JSON.parse(row.eventJson))
                .filter((event) => event.type === "message"),
            ).toEqual([expect.objectContaining({ message })]);
          } finally {
            try {
              await participantSettlement;
              recorder.finishPendingInput?.("interrupted");
              await recorder.waitForPendingInputSettlement?.();
            } finally {
              await input.actor.release();
            }
          }
        }),
      );
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          throw outcome.reason;
        }
      }
    });
  },
);

it.each([
  { phase: "acceptInput", change: "metadata" },
  { phase: "adoptRun", change: "metadata" },
  { phase: "adoptRun", change: "lifecycle" },
  { phase: "adoptRun", change: "authority" },
] as const)(
  "preserves input persistence and authority when $change changes before $phase admission",
  async ({ phase, change }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const f = createSessionCompoundWorkerFixture();
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("Input authority revoked");
        }
      };
      const input = await acquireInput({ ...f.scope, target: f.target }, assertCurrent);
      const recorder = recorderFor(f, "Keep the original admission", "fenced-input");
      await input.actor.read({ assertCurrent, authorize: assertCurrent });
      bindUserTurnInputActor(recorder, { phase, acquire: async () => input });
      let metadataWrites = 0;
      const afterCompetingWrite = async <T>(submit: () => Promise<T>) => {
        await patchSessionEntryCore(f.scope, () =>
          change === "lifecycle"
            ? { abortedLastRun: true }
            : { displayName: `Updated ${++metadataWrites}` },
        );
        current = change !== "authority";
        return submit();
      };
      const accept = input.actor.acceptInput;
      const adopt = input.actor.adoptRun;
      // Every submission observes a real metadata write, including a cache-version retry.
      const competingWrite =
        phase === "acceptInput"
          ? vi
              .spyOn(input.actor, "acceptInput")
              .mockImplementation((...args) => afterCompetingWrite(() => accept(...args)))
          : vi
              .spyOn(input.actor, "adoptRun")
              .mockImplementation((...args) => afterCompetingWrite(() => adopt(...args)));
      try {
        if (change === "metadata") {
          await expect(recorder.persistApproved()).resolves.toMatchObject({ appended: true });
          await recorder.persistFallback();
          expect(f.read()?.displayName).toBe(`Updated ${metadataWrites}`);
          expect(f.events().filter((event) => event.type === "message")).toEqual([
            expect.objectContaining({
              message: expect.objectContaining({ content: "Keep the original admission" }),
            }),
          ]);
        } else {
          await expect(recorder.persistApproved()).rejects.toThrow(
            change === "lifecycle" ? "refused by its current owner" : "Input authority revoked",
          );
          expect(recorder.hasPersisted()).toBe(false);
          expect(f.events()).toEqual([]);
        }
      } finally {
        competingWrite.mockRestore();
        await input.actor.release();
      }
    });
  },
);
