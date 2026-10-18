import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import * as executionOwner from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createSessionEntryWithTranscript,
  prepareSessionEntryMutationDatabases,
} from "./session-accessor.entry-mutation.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { readSessionEntryInWorker } from "./session-entry-read-runtime.js";

type Scope = Parameters<typeof createSessionEntryWithTranscript>[0];
type Preparation = ReturnType<typeof prepareSessionEntryMutationDatabases>;

const prepare = (scope: Scope, ready = Promise.resolve()) =>
  prepareSessionEntryMutationDatabases([{ scope, assertCurrent() {} }], ready);

async function create(scope: Scope, preparation: Preparation, sessionId: string) {
  const storage = await preparation.preparations[0]!;
  return createSessionEntryWithTranscript(
    scope,
    () => ({ ok: true, entry: { sessionId, updatedAt: 1 } }),
    { commitGuard: storage.assertCurrent },
  );
}

it("creates distinct sessions through concurrent first-store preparations", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("fresh.sqlite");
    const scopes = Array.from({ length: 8 }, (_, index) => ({
      agentId: "main",
      sessionKey: `agent:main:concurrent-${index}`,
      storePath,
      env: state.env,
    }));
    const preparations = scopes.map((scope) => prepare(scope));
    try {
      const results = await Promise.allSettled(
        preparations.map((preparation, index) =>
          create(scopes[index]!, preparation, `created-${index}`),
        ),
      );
      expect(results).toEqual(
        scopes.map((_, index) => ({
          status: "fulfilled",
          value: expect.objectContaining({
            ok: true,
            entry: expect.objectContaining({ sessionId: `created-${index}` }),
          }),
        })),
      );
      const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      expect(
        scopes.map(
          (scope) => readExactSessionEntryRow(database, scope.sessionKey)?.entry.sessionId,
        ),
      ).toEqual(scopes.map((_, index) => `created-${index}`));
    } finally {
      await Promise.all(preparations.map((preparation) => preparation[Symbol.asyncDispose]()));
    }
  });
});

it("retains a shared store's first creation while a sibling awaits authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("delayed-shared.sqlite");
    const scope = { agentId: "main", sessionKey: "agent:main:first", storePath, env: state.env };
    const followerScope = { ...scope, agentId: "other", sessionKey: "agent:other:follower" };
    const ready = createDeferred();
    await using first = prepare(scope);
    await using follower = prepareSessionEntryMutationDatabases(
      [{ scope: followerScope, assertCurrent() {}, relatedScopes: [scope] }],
      ready.promise,
    );
    try {
      await first.preparations[0];
      ready.resolve();
      const created = await create(followerScope, follower, "delayed-follower");
      expect(created).toMatchObject({ ok: true, entry: { sessionId: "delayed-follower" } });
      const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      expect(readExactSessionEntryRow(database, followerScope.sessionKey)?.entry.sessionId).toBe(
        "delayed-follower",
      );
    } finally {
      ready.resolve();
    }
  });
});

it.each(["before-ready", "before-native-open"])(
  "prepares valid followers after initiating authority ends %s",
  async (stage) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("revoked.sqlite");
      const ready = createDeferred();
      const entered = createDeferred();
      const resume = createDeferred();
      let current = true;
      const capture = executionOwner.captureOpenClawAgentDatabaseExecution;
      const intercept =
        stage === "before-native-open"
          ? vi
              .spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution")
              .mockImplementationOnce((...args) => {
                const execution = capture(...args);
                let first = true;
                return {
                  ...execution,
                  get fileIdentity() {
                    return execution.fileIdentity;
                  },
                  async prepare(source, signal) {
                    if (first) {
                      first = false;
                      entered.resolve();
                      await resume.promise;
                    }
                    await execution.prepare(source, signal);
                  },
                };
              })
          : undefined;
      await using first = prepareSessionEntryMutationDatabases(
        [
          {
            scope: { agentId: "main", sessionKey: "agent:main:first", storePath, env: state.env },
            assertCurrent() {
              if (!current) {
                throw new Error("Caller authority ended");
              }
            },
          },
        ],
        ready.promise,
      );
      const followers = Array.from({ length: 3 }, (_, index) => {
        const scope = {
          agentId: "main",
          sessionKey: `agent:main:follower-${index}`,
          storePath,
          env: state.env,
        };
        return {
          scope,
          preparation: prepare(scope, ready.promise),
        };
      });
      try {
        if (stage === "before-native-open") {
          ready.resolve();
          await awaitGateBeforeSettlement(
            entered.promise,
            first.preparations[0]!,
            "Initiator settled before native admission",
          );
        }
        current = false;
        ready.resolve();
        resume.resolve();
        await expect(first.preparations[0]).rejects.toThrow("Caller authority ended");
        const results = await Promise.all(
          followers.map(({ scope, preparation }, index) =>
            create(scope, preparation, `follower-${index}`),
          ),
        );
        expect(results.map((result) => result.ok && result.entry.sessionId)).toEqual([
          "follower-0",
          "follower-1",
          "follower-2",
        ]);
      } finally {
        ready.resolve();
        resume.resolve();
        await Promise.all(followers.map(({ preparation }) => preparation[Symbol.asyncDispose]()));
        intercept?.mockRestore();
      }
    });
  },
);

it("shares cold-store preparation between logical reads and session creation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("read.sqlite");
    const reads = Array.from({ length: 4 }, (_, index) =>
      readSessionEntryInWorker({
        agentId: "main",
        sessionKey: `agent:main:read-${index}`,
        storePath,
        env: state.env,
      }),
    );
    const scope = { agentId: "main", sessionKey: "agent:main:mixed", storePath, env: state.env };
    await using creation = prepare(scope);
    const creating = create(scope, creation, "mixed");
    const results = await Promise.allSettled([...reads, creating]);
    expect(results).toEqual([
      ...Array.from({ length: 4 }, () => ({ status: "fulfilled", value: undefined })),
      {
        status: "fulfilled",
        value: expect.objectContaining({
          ok: true,
          entry: expect.objectContaining({ sessionId: "mixed" }),
        }),
      },
    ]);
    await expect(fs.stat(storePath)).resolves.toBeDefined();
  });
});
