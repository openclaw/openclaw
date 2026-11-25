import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { expect, it, vi } from "vitest";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { observeMainThreadFs } from "../../test-utils/main-thread-fs-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import {
  prepareForeignLiveSessionPendingInputEntries,
  readSessionSubmittedInput,
} from "./session-accessor.pending-inputs.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import {
  withSessionTranscriptReadSource,
  type SessionTranscriptWorkerReadSource,
} from "./session-transcript-read-source.js";
import { readTranscriptStatsAsync } from "./session-transcript-stats.js";
import { readSessionTranscriptWatermarkAsync } from "./session-transcript-watermark.js";
import * as preparation from "./session-transcript-worker-resources.js";
import {
  getOwnedSessionTranscriptReader,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";

it("carries admitted transcript identity into watermark reads without synchronous path lookup", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionKey: "agent:main:admitted-watermark",
      sessionId: "admitted-watermark",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(scope, [
      { type: "message", id: "question", message: { role: "user", content: "synthetic" } },
    ]);
    const replacement = { ...scope, storePath: state.statePath("replacement.sqlite") };
    await upsertSessionEntryCore(replacement, { sessionId: scope.sessionId, updatedAt: 2 });
    await closeOpenClawAgentDatabaseByPathAsync(replacement.storePath);
    const { databaseClaim } = await loadSessionEntryForAdmission(scope);
    if (!("kind" in databaseClaim) || databaseClaim.kind !== "worker" || !databaseClaim.reader) {
      throw new Error("Expected admitted durable session reader");
    }
    try {
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scope,
          sessionReader: databaseClaim.reader,
          withTranscriptWrite: async (write) => write(),
        },
        async () => {
          await readSessionTranscriptWatermarkAsync(scope);
          const stat = vi.spyOn(fs, "statSync");
          const realpath = vi.spyOn(fs.realpathSync, "native");
          syncBuiltinESMExports();
          try {
            const pending = readSessionTranscriptWatermarkAsync(scope);
            const synchronousCalls = stat.mock.calls.length + realpath.mock.calls.length;
            await expect(pending).resolves.toMatchObject({ maxSeq: 0 });
            expect(synchronousCalls).toBe(0);
            const foreign = await prepareForeignLiveSessionPendingInputEntries(scope);
            expect(await foreign()).toEqual(new Map());
            expect(stat.mock.calls.length + realpath.mock.calls.length).toBe(0);
          } finally {
            stat.mockRestore();
            realpath.mockRestore();
            syncBuiltinESMExports();
          }
          const originalPath = state.statePath("retained.sqlite");
          await fs.promises.rename(scope.storePath, originalPath);
          try {
            await fs.promises.copyFile(replacement.storePath, scope.storePath);
            await expect(readSessionTranscriptWatermarkAsync(scope)).rejects.toThrow(
              /identity|changed|revoked|current|admission/i,
            );
          } finally {
            await fs.promises.rename(originalPath, scope.storePath);
          }
        },
      );
    } finally {
      await databaseClaim.release();
    }
  }));

it("settles detached watermark and stats reads without synchronous filesystem work", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const gateway = acquireGatewayStateOwner({
      databasePath: resolveOpenClawStateSqlitePath(state.env),
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: state.configPath,
        role: "gateway",
        processNamespace: readGatewayLockProcessNamespace(),
      },
    });
    try {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:detached-watermark",
        sessionId: "detached-watermark",
        storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      };
      await replaceTranscriptEvents(scope, [
        {
          type: "message",
          id: "question",
          message: {
            role: "user",
            content: "synthetic",
            timestamp: 1,
            idempotencyKey: "detached:user",
          },
        },
      ]);
      expect(getOwnedSessionTranscriptReader(scope)).toBeUndefined();
      await readSessionTranscriptWatermarkAsync(scope);
      await readTranscriptStatsAsync(scope);
      const calls = observeMainThreadFs();
      let watermark: Awaited<ReturnType<typeof readSessionTranscriptWatermarkAsync>>;
      let stats: Awaited<ReturnType<typeof readTranscriptStatsAsync>>;
      try {
        watermark = await readSessionTranscriptWatermarkAsync(scope);
        stats = await readTranscriptStatsAsync(scope);
        expect(await readSessionSubmittedInput(scope, "detached:user")).toMatchObject({
          role: "user",
          content: "synthetic",
          idempotencyKey: "detached:user",
        });
      } finally {
        calls[Symbol.dispose]();
      }
      expect(watermark).toMatchObject({ maxSeq: 0 });
      expect(stats).toMatchObject({ eventCount: 1, maxSeq: 0 });
      expect(calls.stacks()).toEqual([]);
    } finally {
      await closeOpenClawAgentDatabasesAsync();
      gateway.release();
    }
  }));

it.each(["first creation", "unlisted file", "retargeted alias"] as const)(
  "keeps detached transcript custody through %s after preparation",
  (change) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: change === "unlisted file" ? "worker" : "main",
        env: state.env,
        sessionKey: `agent:${change === "unlisted file" ? "worker" : "main"}:detached-custody`,
        sessionId: "detached-custody",
        storePath:
          change === "unlisted file"
            ? state.path("shared.json")
            : state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      };
      const events: TranscriptEvent[] = [
        { type: "message", id: "question", message: { role: "user", content: "synthetic" } },
      ];
      const replacementPath = state.path("replacement.sqlite");
      if (change === "unlisted file") {
        await replaceTranscriptEvents(
          {
            ...scope,
            agentId: "main",
            sessionKey: "agent:main:detached-custody",
            storePath: state.path("shared.sqlite"),
          },
          events,
        );
      } else if (change === "retargeted alias") {
        await replaceTranscriptEvents(scope, events);
        await replaceTranscriptEvents({ ...scope, storePath: replacementPath }, events);
        const alias = state.path("alias.sqlite");
        await fs.promises.symlink(scope.storePath, alias);
        scope.storePath = alias;
      }
      const prepare = preparation.prepareSessionStoreCandidatesInWorker;
      let qualified = false;
      using _ = vi
        .spyOn(preparation, "prepareSessionStoreCandidatesInWorker")
        .mockImplementationOnce(async (request) => {
          const result = await prepare(request);
          qualified = true;
          if (change === "retargeted alias") {
            await fs.promises.unlink(scope.storePath);
            await fs.promises.symlink(replacementPath, scope.storePath);
          } else if (change === "unlisted file") {
            const databasePath = state.path("shared.worker.sqlite");
            openOpenClawAgentDatabase({ agentId: "worker", path: databasePath, env: state.env });
            await closeOpenClawAgentDatabaseByPathAsync(databasePath);
          } else {
            await replaceTranscriptEvents(scope, events);
          }
          return result;
        });
      const consume = vi.fn(async (source: SessionTranscriptWorkerReadSource) =>
        source.owner.readWatermark({
          scope: source.scope,
          expectedIdentity: source.expectedIdentity,
        }),
      );
      const reading = withSessionTranscriptReadSource(scope, consume);
      if (change === "first creation") {
        await expect(reading).resolves.toMatchObject({ maxSeq: 0 });
        expect(consume).toHaveBeenCalledOnce();
      } else {
        await expect(reading).rejects.toThrow(/identity|changed|custody/i);
        expect(consume).not.toHaveBeenCalled();
      }
      expect(qualified).toBe(true);
    }),
);
