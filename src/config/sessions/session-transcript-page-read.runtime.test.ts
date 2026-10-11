import { expect, it, vi } from "vitest";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { startTranscriptPageRead } from "./session-transcript-page-read.operation.js";
import {
  acquireHistoryDatabaseResource,
  historyLane,
  type SessionHistoryDatabaseTarget,
} from "./session-transcript-worker-resources.js";

const limits = { limit: 2, maxScannedEntries: 1000, maxMaterializedBytes: 16 * 1024 * 1024 };
const bigLimits = { ...limits, limit: 50 };

type PageFixture = {
  scope: {
    agentId: string;
    sessionKey: string;
    sessionId: string;
    path: string;
    env: NodeJS.ProcessEnv;
  };
  target: SessionHistoryDatabaseTarget;
};

async function withPageFixture(
  events: Parameters<typeof replaceTranscriptEvents>[1],
  run: (fixture: PageFixture) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const writer = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:page-runtime",
      sessionId: "page-runtime",
      path: writer.path,
      env,
    };
    writeSessionEntry(writer, scope.sessionKey, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "original",
    });
    await replaceTranscriptEvents({ ...scope, storePath: scope.path }, events);
    await closeOpenClawAgentDatabaseByPathAsync(writer.path);
    await run({ scope, target: { agentId: scope.agentId, path: scope.path } });
  });
}

function operationInput(fixture: PageFixture, deadlineAt: number, requestLimits = limits) {
  return {
    request: {
      scope: fixture.scope,
      expectedLifecycleRevision: "original",
      limits: requestLimits,
    },
    expectedIdentity: readDatabasePathIdentitySync(fixture.scope.path),
    deadlineAt,
  };
}

it("resolves a page and completes settlement with final accounting", async () => {
  await withPageFixture(
    [
      { type: "session", id: "page-runtime", version: 3 },
      { type: "message", id: "one", message: { role: "user", content: "one" } },
    ],
    async (fixture) => {
      const operation = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      const response = await operation.response;
      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.value.records.map((entry) => entry.storedEntryId)).toEqual([
          fixture.scope.sessionId,
          "one",
        ]);
        expect(response.budget.final).toBe(true);
      }
      await expect(operation.settled).resolves.toMatchObject({
        final: true,
        scannedEntries: expect.any(Number),
      });
      const second = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      await expect(second.response.then((value) => value.ok)).resolves.toBe(true);
      await second.settled;
    },
  );
});

it("returns timed_out without dispatch when the deadline already elapsed", async () => {
  await withPageFixture([{ type: "session", id: "page-runtime", version: 3 }], async (fixture) => {
    const operation = startTranscriptPageRead(
      fixture.target,
      operationInput(fixture, performance.now() - 1),
    );
    await expect(operation.response).resolves.toMatchObject({
      ok: false,
      error: "timed_out",
      budget: { final: false },
    });
    await expect(operation.settled).resolves.toMatchObject({ final: false });
  });
});

it("rejects deadline windows beyond the five-second operation budget", async () => {
  await withPageFixture([{ type: "session", id: "page-runtime", version: 3 }], async (fixture) => {
    expect(() =>
      startTranscriptPageRead(fixture.target, operationInput(fixture, performance.now() + 5001)),
    ).toThrow(/deadline/);
    expect(() =>
      startTranscriptPageRead(fixture.target, operationInput(fixture, Number.NaN)),
    ).toThrow(/finite/);
  });
});

it("times out during execution and queue phases, settles custody, and admits the successor", async () => {
  const bulky = Array.from({ length: 40 }, (_, index) => ({
    type: "message",
    id: `bulky-${index}`,
    message: { role: "user", content: "x".repeat(400_000) },
  }));
  await withPageFixture(
    [{ type: "session", id: "page-runtime", version: 3 }, ...bulky],
    async (fixture) => {
      // The 16 MiB materialization cannot finish inside a 1 ms pool timeout.
      const executing = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 1, bigLimits),
      );
      // Waiting behind the first settlement (including worker rotation) must
      // not refresh this operation's own deadline.
      const queued = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 1, bigLimits),
      );
      let firstSettled = false;
      void executing.settled.then(() => {
        firstSettled = true;
      });
      await expect(executing.response).resolves.toMatchObject({
        ok: false,
        error: "timed_out",
        budget: { final: false },
      });
      await expect(queued.response).resolves.toMatchObject({
        ok: false,
        error: "timed_out",
        budget: { final: false },
      });
      await executing.settled;
      await queued.settled;
      const successor = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000, bigLimits),
      );
      const successorOk = await successor.response.then((value) => value.ok);
      expect(successorOk).toBe(true);
      expect(firstSettled).toBe(true);
      await successor.settled;
    },
  );
});

it("revokes publication for an idempotent cancel and keeps the lane usable", async () => {
  await withPageFixture(
    [
      { type: "session", id: "page-runtime", version: 3 },
      { type: "message", id: "one", message: { role: "user", content: "one" } },
    ],
    async (fixture) => {
      const operation = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      operation.cancel();
      operation.cancel();
      await expect(operation.response).resolves.toMatchObject({
        ok: false,
        error: "timed_out",
        budget: { final: false },
      });
      await operation.settled;
      const successor = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      await expect(successor.response.then((value) => value.ok)).resolves.toBe(true);
      await successor.settled;
    },
  );
});

it("keeps admission closed when worker retirement fails during a timeout", async () => {
  await withPageFixture([{ type: "session", id: "page-runtime", version: 3 }], async (fixture) => {
    const run = vi.spyOn(historyLane.pool, "run").mockImplementation(((factory: () => unknown) => {
      // Assign native custody exactly as the pool would, then time out.
      factory();
      return Promise.reject(new WorkerTaskError("worker task timed out", "timeout"));
    }) as typeof historyLane.pool.run);
    const rotate = vi
      .spyOn(historyLane.pool, "rotate")
      .mockImplementation(() => Promise.reject(new Error("retirement failed")));
    try {
      const operation = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      await expect(operation.response).rejects.toThrow(/worker retirement failed/);
      await expect(operation.settled).rejects.toThrow(/worker retirement failed/);
      const successor = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      await expect(successor.response).rejects.toThrow(/admission is closed/);
      await expect(successor.settled).rejects.toThrow(/admission is closed/);
    } finally {
      run.mockRestore();
      rotate.mockRestore();
    }
  });
});

it("settles a canceled operation across a mid-flight source replacement", async () => {
  await withPageFixture(
    [
      { type: "session", id: "page-runtime", version: 3 },
      { type: "message", id: "one", message: { role: "user", content: "one" } },
    ],
    async (fixture) => {
      const operation = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      operation.cancel();
      const originalPath = fixture.scope.path;
      const fs = await import("node:fs");
      fs.renameSync(originalPath, originalPath + ".original");
      fs.writeFileSync(originalPath, "synthetic replacement; must never be read");
      try {
        await expect(operation.response).resolves.toMatchObject({
          ok: false,
          error: "timed_out",
        });
        await operation.settled;
        const replaced = startTranscriptPageRead(fixture.target, {
          ...operationInput(fixture, performance.now() + 5000),
          expectedIdentity: readDatabasePathIdentitySync(originalPath),
        });
        await expect(replaced.response).resolves.toMatchObject({ ok: false, error: "read_failed" });
        await expect(replaced.settled).resolves.toMatchObject({ final: false });
      } finally {
        fs.rmSync(originalPath + ".original", { force: true });
      }
    },
  );
});

it("holds the resource for the whole native read", async () => {
  const bulky = Array.from({ length: 40 }, (_, index) => ({
    type: "message",
    id: `bulky-${index}`,
    message: { role: "user", content: "x".repeat(400_000) },
  }));
  await withPageFixture(
    [{ type: "session", id: "page-runtime", version: 3 }, ...bulky],
    async (fixture) => {
      const resource = acquireHistoryDatabaseResource(fixture.target);
      const operation = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000, bigLimits),
      );
      const pendingDuringFlight = await new Promise<number>((resolve) => {
        setImmediate(() => resolve(resource.pending));
      });
      expect(pendingDuringFlight).toBeGreaterThan(0);
      const response = await operation.response;
      expect(response.ok).toBe(true);
      await operation.settled;
    },
  );
});
