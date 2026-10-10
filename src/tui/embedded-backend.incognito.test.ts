import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import * as preparedModelCatalog from "../agents/prepared-model-catalog.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { openIncognitoTestActor } from "../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { EmbeddedTuiBackend } from "./embedded-backend.js";

const provider = vi.hoisted(() => ({ run: vi.fn() }));
// The local adapter owns source selection and settlement; provider execution is the external boundary.
vi.mock("../agents/agent-command.js", () => ({ agentCommandFromIngress: provider.run }));
vi.mock("../agents/btw.js", () => ({
  runBtwSideQuestion: vi.fn(async () => ({ text: "A private side answer" })),
}));

afterEach(() => vi.clearAllMocks());

it("uses the bound actor for local history, describe, patch, goals, cost and reset policy", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/gpt-4.1-mini" } },
        entries: { main: { workspace: state.workspaceDir } },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:dashboard:incognito-local-consumers";
    const authority = { assertCurrent() {} };
    const actor = await openIncognitoTestActor(state.env, authority);
    const backend = new EmbeddedTuiBackend();
    const sql = observeHostDataSql();
    try {
      await withIncognitoSessionBinding({ actor }, async () => {
        const created = await backend.createSession({ key });
        expect(created.entry.incognito).toBe(true);
        await backend.patchSession({ key, thinkingLevel: "off" });
        expect((await backend.loadHistory({ sessionKey: key })).sessionId).toBe(
          created.entry.sessionId,
        );
        expect((await backend.describeSession({ sessionKey: key })).session?.sessionId).toBe(
          created.entry.sessionId,
        );
        expect((await backend.patchSession({ key, verboseLevel: "on" })).entry.verboseLevel).toBe(
          "on",
        );
        await backend.runGoalCommand({ sessionKey: key, command: "/goal start Keep it private" });
        expect(
          (await backend.runGoalCommand({ sessionKey: key, command: "/goal status" })).text,
        ).toContain("Keep it private");
        expect((await backend.runUsageCostCommand({ sessionKey: key })).text).toContain(
          "Usage cost",
        );
        await expect(backend.resetSession(key)).rejects.toThrow("cannot reset in place");
      });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      await backend.stop();
      await actor.release();
      await actor.close();
    }
  });
});

it("refuses a local patch when actor authority changes during catalog preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({
      agents: {
        defaults: { model: { primary: "openai/gpt-4.1-mini" } },
        entries: { main: { workspace: state.workspaceDir } },
      },
    });
    const key = "agent:main:dashboard:incognito-local-patch";
    let current = true;
    const authority = {
      assertCurrent() {
        if (!current) {
          throw new Error("Local patch authority revoked");
        }
      },
    };
    const actor = await openIncognitoTestActor(state.env, authority);
    const backend = new EmbeddedTuiBackend();
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    const loadCatalog = preparedModelCatalog.loadPreparedModelCatalogSnapshot;
    let patching: ReturnType<EmbeddedTuiBackend["patchSession"]> | undefined;
    try {
      await withIncognitoSessionBinding({ actor }, async () => {
        const created = await backend.createSession({ key });
        const catalog = vi
          .spyOn(preparedModelCatalog, "loadPreparedModelCatalogSnapshot")
          .mockImplementationOnce(async (options) => {
            const snapshot = await loadCatalog(options);
            entered.resolve();
            await finish.promise;
            return snapshot;
          });
        const sql = observeHostDataSql();
        try {
          patching = backend.patchSession({ key, thinkingLevel: "off" });
          const rejected = expect(patching).rejects.toThrow("Local patch authority revoked");
          await entered.promise;
          current = false;
          finish.resolve();
          await rejected;
          current = true;
          const unchanged = await actor.sessions.read(authority, { sessionKey: key });
          expect(unchanged.entry?.thinkingLevel).toBe(created.entry.thinkingLevel);
          expect(unchanged.entry?.updatedAt).toBe(created.entry.updatedAt);
          expect(sql.queries).toEqual([]);
        } finally {
          current = true;
          finish.resolve();
          await patching?.catch(() => undefined);
          sql.restore();
          catalog.mockRestore();
        }
      });
    } finally {
      current = true;
      finish.resolve();
      await backend.stop();
      await actor.release();
      await actor.close();
    }
  });
});

it("joins an accepted bound local run on stop and keeps unbound incognito native", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: { workspace: state.workspaceDir } } } });
    const key = "agent:main:dashboard:incognito-local-stop";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key, env: state.env },
      { sessionId: "native-local", updatedAt: 1, incognito: true, thinkingLevel: "off" },
    );
    const nativeBackend = new EmbeddedTuiBackend();
    expect((await nativeBackend.loadHistory({ sessionKey: key })).sessionId).toBe("native-local");
    await withIncognitoSessionBinding(
      { kind: "absent", agentId: "main", env: state.env, authority: { assertCurrent() {} } },
      async () => {
        expect((await nativeBackend.describeSession({ sessionKey: key })).session).toBeNull();
      },
    );
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(state.env)).toEqual([]);
    await nativeBackend.stop();
    await closeOpenClawAgentDatabaseByPathAsync(
      resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
    );

    const authority = { assertCurrent() {} };
    const actor = await openIncognitoTestActor(state.env, authority);
    await actor.sessions.create(authority, {
      sessionKey: key,
      entry: { sessionId: "actor-local", updatedAt: 1, incognito: true },
    });
    const entered = createDeferredCore();
    const finish = createDeferredCore<{
      payloads: { text: string }[];
      meta: Record<string, unknown>;
    }>();
    provider.run.mockImplementationOnce((request: { sessionId?: string }) => {
      expect(request.sessionId).toBe("actor-local");
      entered.resolve();
      return finish.promise;
    });
    const backend = new EmbeddedTuiBackend();
    try {
      await withIncognitoSessionBinding({ actor }, async () => {
        await backend.sendChat({ sessionKey: key, message: "hello", runId: "private-local-run" });
        await entered.promise;
        let stopped = false;
        const stopping = backend.stop().then(() => {
          stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        finish.resolve({ payloads: [{ text: "finished" }], meta: {} });
        await stopping;
        expect(stopped).toBe(true);
      });
    } finally {
      finish.resolve({ payloads: [], meta: {} });
      await backend.stop();
      await actor.release();
      await actor.close();
    }
  });
});

it("does not publish a first-turn reply after its creating actor loses authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: { workspace: state.workspaceDir } } } });
    const key = "agent:main:dashboard:incognito-local-first-turn";
    let current = true;
    const authority = {
      assertCurrent() {
        if (!current) {
          throw new Error("Local actor authority revoked");
        }
      },
    };
    const actor = await openIncognitoTestActor(state.env, authority);
    const backend = new EmbeddedTuiBackend();
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    const terminal = createDeferredCore<unknown>();
    const events: unknown[] = [];
    backend.onEvent = (event) => {
      events.push(event);
      if (event.event === "chat") {
        terminal.resolve(event.payload);
      }
    };
    provider.run.mockImplementationOnce(
      async (request: { sessionId?: string; onExecutionStarted?: () => unknown }) => {
        expect(request.sessionId).toBeUndefined();
        await backend.createSession({ key });
        await request.onExecutionStarted?.();
        entered.resolve();
        await finish.promise;
        return { payloads: [{ text: "Private first-turn answer" }], meta: {} };
      },
    );
    try {
      await withIncognitoSessionBinding({ actor }, async () => {
        await backend.sendChat({ sessionKey: key, message: "hello", runId: "local-create" });
        await entered.promise;
        current = false;
        finish.resolve();
        expect(await terminal.promise).toMatchObject({
          state: "error",
          errorMessage: "Local actor authority revoked",
        });
        expect(JSON.stringify(events)).not.toContain("Private first-turn answer");
        await backend.stop();
      });
    } finally {
      current = true;
      finish.resolve();
      await backend.stop();
      await actor.release();
      await actor.close();
    }
  });
});

it("keeps queued sends and side questions on the explicitly selected actor", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: { workspace: state.workspaceDir } } } });
    const key = "agent:main:dashboard:incognito-local-queue";
    const authority = { assertCurrent() {} };
    const actor = await openIncognitoTestActor(state.env, authority);
    await actor.sessions.create(authority, {
      sessionKey: key,
      entry: {
        sessionId: "queued-private",
        updatedAt: 1,
        incognito: true,
        queueMode: "followup",
        queueDebounceMs: 0,
      },
    });
    const firstStarted = createDeferredCore();
    const nextStarted = createDeferredCore();
    const finishFirst = createDeferredCore();
    const finishNext = createDeferredCore();
    provider.run
      .mockImplementationOnce(async (request: { sessionId?: string }) => {
        expect(request.sessionId).toBe("queued-private");
        firstStarted.resolve();
        await finishFirst.promise;
        return { payloads: [{ text: "First answer" }], meta: {} };
      })
      .mockImplementationOnce(async (request: { sessionId?: string; message: string }) => {
        expect(request.sessionId).toBe("queued-private");
        expect(request.message).toBe("Second question");
        nextStarted.resolve();
        await finishNext.promise;
        return { payloads: [{ text: "Second answer" }], meta: {} };
      });
    const sideResult = createDeferredCore<unknown>();
    const backend = new EmbeddedTuiBackend();
    backend.onEvent = (event) => {
      if (event.event === "chat.side_result") {
        sideResult.resolve(event.payload);
      }
    };
    const sql = observeHostDataSql();
    try {
      await withIncognitoSessionBinding({ actor }, async () => {
        await backend.sendChat({
          sessionKey: key,
          message: "First question",
          runId: "local-first",
        });
        await firstStarted.promise;
        await backend.sendChat({
          sessionKey: key,
          message: "Second question",
          runId: "local-next",
        });
        expect(provider.run).toHaveBeenCalledTimes(1);
        await backend.sendChat({
          sessionKey: key,
          message: "/btw side question",
          runId: "local-side",
        });
        expect(await sideResult.promise).toMatchObject({
          sessionKey: key,
          text: "A private side answer",
        });
        finishFirst.resolve();
        await nextStarted.promise;
        finishNext.resolve();
        await backend.stop();
      });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      finishFirst.resolve();
      finishNext.resolve();
      await backend.stop();
      await actor.release();
      await actor.close();
    }
  });
});
