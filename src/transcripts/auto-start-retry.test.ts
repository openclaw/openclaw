import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTranscriptsAutoStartService } from "./auto-start.js";
import type { TranscriptStartRequest, TranscriptsStartResult } from "./provider-types.js";
import {
  transcriptStatusRoom as room,
  useTranscriptStatusFixture,
} from "./status.producer.test-harness.js";
import { transcriptSessionSelector, TranscriptsStore } from "./store.js";

type Service = ReturnType<typeof createTranscriptsAutoStartService>;
const services: Service[] = [];
const gates: ReturnType<typeof createDeferred<void>>[] = [];
const fixture = useTranscriptStatusFixture();
function releaseGate() {
  const gate = createDeferred();
  gates.push(gate);
  return gate;
}
function trackedService(ctx: Parameters<typeof createTranscriptsAutoStartService>[0]) {
  const service = createTranscriptsAutoStartService(ctx);
  services.push(service);
  return service;
}

function retryFixture(
  options: {
    whenOccupied?: boolean;
    title?: string;
    realTimers?: boolean;
    acceptFrom?: number;
  } = {},
) {
  if (!options.realTimers) {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  }
  const { realTimers: _realTimers, acceptFrom, ...source } = options;
  const f = fixture({ transcripts: { autoStart: [{ ...room, ...source }] } });
  if (options.whenOccupied !== undefined) {
    f.provider.watchOccupancy = async (request) => {
      request.onOccupied();
      return { ok: true, value: { stop() {} } };
    };
  }
  let attempts = 0;
  const start = vi.fn(async (request: TranscriptStartRequest): Promise<TranscriptsStartResult> =>
    acceptFrom !== undefined && ++attempts >= acceptFrom
      ? { ok: true, session: request.session }
      : { ok: false, error: "provider unavailable" },
  );
  f.provider.start = start;
  return { f, start, service: trackedService(f.ctx) };
}

async function stopAfterAction(service: Service, action: "stop" | "retry") {
  if (action === "retry") {
    await vi.advanceTimersByTimeAsync(5_000);
    await service.start().settled;
  }
  await service.stop();
}

function pendingStart({ start, service }: ReturnType<typeof retryFixture>, throws = false) {
  const entered = createDeferred<TranscriptStartRequest>();
  const gate = releaseGate();
  start.mockImplementation(async (request) => {
    entered.resolve(request);
    await gate.promise;
    if (throws) {
      throw new Error("provider failed after shutdown");
    }
    return { ok: false, error: "provider unavailable" };
  });
  return { request: entered.promise, release: gate.resolve, settled: service.start().settled };
}

describe("configured transcript failed-start custody", () => {
  // Settle owned startup/cleanup before the outer fixture closes SQLite and resets timers.
  afterEach(async () => {
    for (const gate of gates.splice(0)) {
      gate.resolve();
    }
    for (const service of services.splice(0)) {
      await service.stop();
    }
  });
  it.each([
    { whenOccupied: false, attempts: 12, accepted: false },
    { whenOccupied: true, attempts: 12, accepted: false },
    { whenOccupied: false, attempts: 3, accepted: true },
    { whenOccupied: false, attempts: 1, accepted: false },
    { whenOccupied: false, attempts: 2, accepted: false },
  ])(
    "retains normalized retry custody (occupied=$whenOccupied, attempts=$attempts, accepted=$accepted)",
    async ({ whenOccupied, attempts, accepted }) => {
      const { f, service, start } = retryFixture({
        whenOccupied,
        acceptFrom: accepted ? attempts : undefined,
        title: "Meeting \ud800",
      });
      await service.start().settled;
      const original = start.mock.calls[0]![0].session;
      expect(await f.store.listSessionEntries()).toMatchObject([
        { session: { title: "Meeting \ufffd" } },
      ]);
      expect((await f.read()).configuredSources[0]?.startDiagnostic).toBe("retrying");
      for (let attempt = 2; attempt <= attempts; attempt++) {
        expect(await f.store.listSessionEntries()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(5_000);
        await service.start().settled;
      }
      expect(start.mock.calls.map(([request]) => request.session.sessionId)).toEqual(
        Array.from({ length: attempts }, () => original.sessionId),
      );
      expect((await f.read()).configuredSources[0]).toMatchObject(
        accepted
          ? { state: "armed" }
          : {
              ...(attempts === 12 ? { state: "not-active" } : {}),
              startDiagnostic: attempts < 12 ? "retrying" : "start-failed",
            },
      );
      expect(await f.store.listSessionEntries()).toHaveLength(attempts < 12 ? 1 : 0);
      await service.stop();
      expect(await f.store.listSessionEntries()).toHaveLength(accepted ? 1 : 0);
      await vi.advanceTimersByTimeAsync(65_000);
      expect(start).toHaveBeenCalledTimes(attempts);
    },
  );

  it.each([
    ["pending", "stop"],
    ["pending", "retry"],
    ["restored", "stop"],
    ["restored", "retry"],
  ] as const)("preserves a %s rewrite through %s custody", async (phase, action) => {
    const setup = retryFixture();
    const { f, service, start } = setup;
    const writeSession = f.store.writeSession.bind(f.store);
    const rewrite = (session: TranscriptStartRequest["session"]) =>
      writeSession({ ...session, title: "Operator-owned meeting" });
    if (phase === "pending") {
      const pending = pendingStart(setup);
      await rewrite((await pending.request).session);
      pending.release();
      await pending.settled;
    } else {
      let rewritten = false;
      vi.spyOn(TranscriptsStore.prototype, "writeSession").mockImplementation(async (...args) => {
        const result = await writeSession(...args);
        if (args[0].stoppedAt && !rewritten) {
          rewritten = true;
          await rewrite(args[0]);
        }
        return result;
      });
      await service.start().settled;
    }
    const { session } = (await f.store.listSessionEntries())[0]!;
    expect(session.title).toBe("Operator-owned meeting");
    await stopAfterAction(service, action);
    expect(start).toHaveBeenCalledOnce();
    expect(await f.store.readSession(session.sessionId)).toEqual(session);
  });

  it("preserves a failed row adopted by a replacement service and lets its retry start", async () => {
    const { f, service: retiring, start } = retryFixture({ whenOccupied: true, acceptFrom: 3 });
    const replacement = trackedService(f.ctx);
    await retiring.start().settled;
    const { session } = (await f.store.listSessionEntries())[0]!;
    const revision = await f.store.readSummaryInputRevision(session);
    await replacement.start().settled;
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1]![0].session.sessionId).toBe(session.sessionId);
    expect(await f.store.readSession(session.sessionId)).toEqual(session);
    expect(await f.store.readSummaryInputRevision(session)).toBe(revision);

    // The replacement restored the same tuple. Only custody, not content checks,
    // can keep the retiring lifecycle from deleting its pending row in SQLite.
    await retiring.stop();
    expect(await f.store.readSession(session.sessionId)).toEqual(session);
    await vi.advanceTimersByTimeAsync(5_000);
    await replacement.start().settled;
    expect(start).toHaveBeenCalledTimes(3);
    expect(start.mock.calls[2]![0].session.sessionId).toBe(session.sessionId);
    expect((await f.read()).active).toMatchObject([{ sessionId: session.sessionId }]);
  });

  it.each(["discarded", "rewritten"] as const)(
    "reselects only a %s candidate before replacement admission",
    async (change) => {
      const { f, service: retiring, start } = retryFixture({ whenOccupied: true, acceptFrom: 2 });
      const replacement = trackedService(f.ctx);
      const selected = createDeferred();
      const release = releaseGate();
      await retiring.start().settled;
      const { session } = (await f.store.listSessionEntries())[0]!;
      const readRecent = f.store.readRecentStoppedSession.bind(f.store);
      vi.spyOn(TranscriptsStore.prototype, "readRecentStoppedSession").mockImplementationOnce(
        async (...args) => {
          const candidate = await readRecent(...args);
          selected.resolve();
          await release.promise;
          return candidate;
        },
      );
      const starting = replacement.start().settled;
      await selected.promise;
      if (change === "rewritten") {
        await f.store.writeSession({ ...session, title: "Operator-owned meeting" });
      }
      await retiring.stop();
      if (change === "discarded") {
        expect(await f.store.readSession(session.sessionId)).toBeUndefined();
      }
      release.resolve();
      await starting;
      await vi.advanceTimersByTimeAsync(5_000);
      await replacement.start().settled;
      if (change === "discarded") {
        expect(start).toHaveBeenCalledTimes(2);
        expect(start.mock.calls[1]![0].session.sessionId).not.toBe(session.sessionId);
        expect((await f.read()).active).toHaveLength(1);
      } else {
        expect(start).toHaveBeenCalledOnce();
        expect(await f.store.readSession(session.sessionId)).toEqual({
          ...session,
          title: "Operator-owned meeting",
        });
        expect((await f.read()).active).toEqual([]);
      }
    },
  );

  it.each([false, true])(
    "discards failed late startup after the stop deadline (occupied=%s)",
    async (whenOccupied) => {
      const setup = retryFixture({ whenOccupied });
      const { f, service, start } = setup;
      const pending = pendingStart(setup, true);
      const request = await pending.request;
      const stopping = service.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      await stopping;
      expect(request.abortSignal?.aborted).toBe(true);
      expect(f.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("stop timed out"));
      pending.release();
      await pending.settled;
      // The original cleanup owner keeps joining after its caller's deadline.
      await service.stop();
      expect(await f.store.listSessionEntries()).toEqual([]);
      await request.onUtterance({ text: "Retired callback" });
      await vi.advanceTimersByTimeAsync(65_000);
      expect(start).toHaveBeenCalledOnce();
      expect(await f.store.listSessionEntries()).toEqual([]);
    },
  );

  it("preserves a failed candidate after operator-stop takes ownership", async () => {
    const { f, service } = retryFixture({ realTimers: true });
    await service.start().settled;
    const { session } = (await f.store.listSessionEntries())[0]!;
    // A failed notes write must not undo the operator's revocation of retry custody.
    vi.spyOn(TranscriptsStore.prototype, "writeSummary").mockRejectedValueOnce(
      new Error("notes temporarily unavailable"),
    );
    await expect(
      f.tool.execute("stop", { action: "stop", selector: transcriptSessionSelector(session) }),
    ).rejects.toThrow("notes temporarily unavailable");
    expect(await f.store.readSummary(session)).toEqual({});
    const preserved = await f.store.readSession(session.sessionId);
    await service.stop();
    expect(await f.store.listSessionEntries()).toHaveLength(1);
    expect(await f.store.readSession(session.sessionId)).toEqual(preserved);
  });
});
