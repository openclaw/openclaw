import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { diffGatewayReloadPaths } from "../gateway/config-diff.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "../gateway/config-reload-plan.js";
import { createTranscriptsAutoStartService } from "./auto-start.js";
import { activeSessions } from "./capture-startup.js";
import * as transcriptCapture from "./capture.js";
import { readTranscriptCaptureSnapshot, startTranscripts } from "./capture.js";
import { readConfiguredTranscriptStarts } from "./configured-start-status.js";
import type { TranscriptOccupancyWatchRequest, TranscriptStartRequest } from "./provider-types.js";
import { readTranscriptLibraryStatus } from "./status.js";
import {
  transcriptStatusRoom as room,
  useTranscriptStatusFixture,
} from "./status.producer.test-harness.js";
import { transcriptSessionSelector, TranscriptsStore } from "./store.js";

const fixture = useTranscriptStatusFixture();

describe("configured transcript source provenance", () => {
  it.each(["reorder", "title"] as const)(
    "retains capture and retry diagnostics across an accepted %s change",
    async (change) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const sources = ["ready", "waiting"].map((sessionId) =>
        Object.assign({}, room, {
          sessionId,
          channelId: sessionId,
          title: `Original ${sessionId}`,
        }),
      );
      const f = fixture({ transcripts: { autoStart: sources } });
      let unavailable = true;
      const start = vi.fn(async (request: TranscriptStartRequest) =>
        unavailable && request.session.sessionId === "waiting"
          ? { ok: false as const, error: "synthetic provider unavailable" }
          : { ok: true as const, session: request.session },
      );
      f.provider.start = start;
      const captureStarts = vi.spyOn(transcriptCapture, "startTranscripts");
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        await service.start().settled;
        expect(readConfiguredTranscriptStarts(f.ctx.config.transcripts)?.get(1)?.diagnostic).toBe(
          "retrying",
        );
        expect((await f.read()).configuredSources).toMatchObject([
          { sessionId: "ready", state: "armed" },
          { sessionId: "waiting", startDiagnostic: "retrying" },
        ]);
        const next = {
          transcripts: {
            autoStart:
              change === "reorder"
                ? sources.toReversed()
                : sources.map((source) =>
                    Object.assign({}, source, { title: `Future ${source.sessionId}` }),
                  ),
          },
        };
        await service.start(next).settled;
        const retained = await readTranscriptLibraryStatus(f.store, next);
        expect(
          retained.configuredSources.find((source) => source.sessionId === "waiting"),
        ).toMatchObject({ startDiagnostic: "retrying" });
        expect(
          retained.configuredSources.find((source) => source.sessionId === "ready"),
        ).toMatchObject({
          state: "armed",
        });
        expect(start).toHaveBeenCalledTimes(2);

        unavailable = false;
        await vi.advanceTimersByTimeAsync(5_000);
        await Promise.allSettled(captureStarts.mock.results.map(({ value }) => value));
        expect((await readTranscriptLibraryStatus(f.store, next)).configuredSources).toMatchObject(
          next.transcripts.autoStart.map(({ sessionId }) => ({ sessionId, state: "armed" })),
        );
        expect(start).toHaveBeenCalledTimes(3);
        // An admitted retry keeps its existing capture title even after a future-title edit.
        expect(start.mock.calls.at(-1)![0].session.title).toBe("Original waiting");
        const status = await readTranscriptLibraryStatus(f.store, next);
        for (const configured of status.configuredSources) {
          const session = await f.store.readSession(configured.sessionId!);
          expect(session).toBeDefined();
          expect(configured.activeSelectors).toEqual([transcriptSessionSelector(session!)]);
        }
      } finally {
        await service.stop();
      }
    },
  );

  it.each([{ name: "title removal", titles: ["First title", undefined], unrelated: true }])(
    "uses the published future title after $name with original routing authority",
    async ({ titles, unrelated }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const source = { ...room, title: "Before", sessionId: "future-title" };
      const f = fixture({
        logging: { level: "info" },
        agents: { entries: { main: {}, notes: {}, other: {} } },
        bindings: [{ agentId: "notes", match: { channel: "discord", accountId: room.accountId } }],
        transcripts: { autoStart: [source] },
      });
      let current = f.ctx.config;
      setRuntimeConfigSnapshot(current, current);
      const publish = (candidate: OpenClawConfig, reloadPlugins = false) => {
        const plan = buildGatewayReloadPlan(
          diffGatewayReloadPaths(current, candidate, listConfigReloadRefinementPrefixes()),
          {
            previousConfig: current,
            candidateConfig: candidate,
          },
        );
        expect(plan.restartGateway).toBe(false);
        expect(plan.reloadPlugins).toBe(reloadPlugins);
        expect(isNoopGatewayReloadPlan(plan)).toBe(!reloadPlugins);
        setRuntimeConfigSnapshot(candidate, candidate);
        current = candidate;
      };
      f.setProviders([]);
      const start = vi.fn(f.provider.start!);
      f.provider.start = start;
      const service = createTranscriptsAutoStartService(
        { ...f.ctx, agentId: undefined },
        () => getRuntimeConfigSnapshot() ?? undefined,
      );
      try {
        await service.start().settled;
        expect(readConfiguredTranscriptStarts(f.ctx.config.transcripts)?.get(0)?.diagnostic).toBe(
          "retrying",
        );
        expect((await f.read()).configuredSources[0]?.startDiagnostic).toBe("retrying");
        expect(await f.store.listSessionEntries()).toHaveLength(0);
        for (const [index, title] of titles.entries()) {
          if (unrelated) {
            publish({ ...current, logging: { level: index === 0 ? "debug" : "warn" } });
            publish({
              ...current,
              bindings: [
                { agentId: "other", match: { channel: "discord", accountId: room.accountId } },
              ],
            });
          }
          const { title: _title, ...intent } = source;
          publish(
            {
              ...current,
              transcripts: {
                autoStart: [{ ...intent, ...(title === undefined ? {} : { title }) }],
              },
            },
            true,
          );
          await vi.advanceTimersByTimeAsync(5_000);
          expect(start).not.toHaveBeenCalled();
          expect(await f.store.listSessionEntries()).toHaveLength(0);
        }
        f.setProviders([f.provider]);
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(async () => expect((await f.read()).active).toHaveLength(1));
        expect(start).toHaveBeenCalledTimes(1);
        const request = start.mock.calls[0]![0];
        expect(request.cfg).toBe(f.ctx.config);
        expect(request.session).toMatchObject({
          sessionId: source.sessionId,
          title: titles.at(-1),
          source: { ...room, agentId: "notes" },
          metadata: { agentId: "notes" },
        });
        await expect(f.store.readSession(source.sessionId)).resolves.toEqual(request.session);
      } finally {
        await service.stop();
      }
    },
  );
  it.each([["unknown provider field", { providerOptions: { mode: "other" } }]])(
    "does not borrow a retry title from changed %s intent",
    async (_name, changed) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const source = {
        ...room,
        sessionId: "original-intent",
        title: "Before",
        meetingUrl: "https://example.test/room?invitation=synthetic-private",
        providerOptions: { mode: "original" },
      };
      const f = fixture({ transcripts: { autoStart: [source] } });
      let current = f.ctx.config;
      f.setProviders([]);
      const start = vi.fn(f.provider.start!);
      f.provider.start = start;
      const service = createTranscriptsAutoStartService(f.ctx, () => current);
      try {
        await service.start().settled;
        expect(readConfiguredTranscriptStarts(f.ctx.config.transcripts)?.get(0)?.diagnostic).toBe(
          "retrying",
        );
        expect((await f.read()).configuredSources[0]?.startDiagnostic).toBe("retrying");
        current = { transcripts: { autoStart: [{ ...source, ...changed, title: "Ineligible" }] } };
        f.setProviders([f.provider]);
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
        const request = start.mock.calls[0]![0];
        expect(request.cfg).toBe(f.ctx.config);
        expect(request.session).toMatchObject({
          title: "Before",
          source: { ...room, meetingUrl: source.meetingUrl, agentId: "main" },
        });
        await expect(f.store.readSession(source.sessionId)).resolves.toMatchObject({
          title: "Before",
          source: { ...room, meetingUrl: "https://example.test/room", agentId: "main" },
        });
      } finally {
        await service.stop();
      }
    },
  );
  it.each([
    { outcome: "throw", fixed: false, title: undefined, failures: 1 },
    { outcome: "reject", fixed: false, title: undefined, failures: 12 },
  ])(
    "retains admission and notes after $outcome (fixed=$fixed, title=$title, failures=$failures)",
    async ({ outcome, fixed, title, failures }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const source = { ...room, sessionId: fixed ? "failed-admission" : undefined, title };
      const f = fixture({
        transcripts: { autoStart: [source] },
      });
      let current = f.ctx.config;
      const entered = createDeferred<TranscriptStartRequest>();
      const start = vi.fn(async (candidate: TranscriptStartRequest) => {
        entered.resolve(candidate);
        await candidate.onUtterance({ text: `Valid note ${start.mock.calls.length}`, final: true });
        if (start.mock.calls.length > failures) {
          return {
            ok: true as const,
            session: { ...candidate.session, title: "Provider title after retry" },
          };
        }
        if (outcome === "throw") {
          throw new Error("synthetic-secret https://example.test/?invite=private /private/stack");
        }
        return {
          ok: false as const,
          error: "synthetic-secret https://example.test/?invite=private",
        };
      });
      f.provider.start = start;
      const service = createTranscriptsAutoStartService(f.ctx, () => current);
      try {
        await service.start().settled;
        const request = await entered.promise;
        expect(readConfiguredTranscriptStarts(f.ctx.config.transcripts)?.get(0)?.diagnostic).toBe(
          "retrying",
        );
        expect((await f.read()).configuredSources[0]).toMatchObject({
          startDiagnostic: "retrying",
          state: "unknown",
        });
        const admitted = structuredClone(request.session);
        const before = await f.store.readSession(admitted.sessionId);
        current = { transcripts: { autoStart: [{ ...source, title: "Future title" }] } };
        const attempts = Math.min(failures + 1, 12);
        for (let attempt = 2; attempt <= attempts; attempt++) {
          await vi.advanceTimersByTimeAsync(5_000);
          await vi.waitFor(
            () => {
              expect(start).toHaveBeenCalledTimes(attempt);
              expect(
                readConfiguredTranscriptStarts(f.ctx.config.transcripts)?.get(0)?.diagnostic,
              ).toBe(attempt > failures ? undefined : attempt === 12 ? "start-failed" : "retrying");
            },
            { interval: 0 },
          );
        }
        expect(start).toHaveBeenCalledTimes(attempts);
        for (const [candidate] of start.mock.calls) {
          expect(candidate.session).toEqual(admitted);
        }
        await request.onUtterance({ text: "Stale callback", final: true });
        await expect(f.store.readUtterancesForSession(admitted)).resolves.toMatchObject(
          Array.from({ length: attempts }, (_, index) => ({ text: `Valid note ${index + 1}` })),
        );
        const { stoppedAt: _stoppedAt, ...running } = before!;
        await expect(f.store.readSession(admitted.sessionId)).resolves.toEqual(
          failures < 12 ? running : before,
        );
        expect(await f.store.listSessionEntries()).toHaveLength(1);
        const configured = (await f.read()).configuredSources[0];
        expect(configured?.state).toBe(failures < 12 ? "armed" : "not-active");
        if (failures < 12) {
          expect(configured).not.toHaveProperty("startDiagnostic");
        } else {
          expect(configured?.startDiagnostic).toBe("start-failed");
        }
        await vi.advanceTimersByTimeAsync(65_000);
        expect(start).toHaveBeenCalledTimes(attempts);
        expect(JSON.stringify([await f.read(), f.ctx.logger.warn.mock.calls])).not.toMatch(
          /synthetic-secret|invite=private|\/private\/stack|UNIQUE/,
        );
      } finally {
        await service.stop();
      }
    },
  );

  it.each(["thrown-stop", "summary-write"] as const)(
    "retains failed startup cleanup custody after %s",
    async (fault) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture({
        transcripts: {
          autoStart: [room],
        },
      });
      const start = vi.fn(async (request: TranscriptStartRequest) => {
        await request.onUtterance({ text: "Admitted note", final: true });
        return { ok: true as const, session: { ...request.session, title: "Room title" } };
      });
      f.provider.start = start;
      const stop = vi.spyOn(f.provider, "stop");
      const originalWrite = f.store.writeSession.bind(f.store);
      let titleFailed = false;
      let cleanupFails = true;
      vi.spyOn(TranscriptsStore.prototype, "writeSession").mockImplementation(
        async (session, condition) => {
          if (session.title === "Room title" && !titleFailed) {
            titleFailed = true;
            throw new Error("title write unavailable");
          }
          await originalWrite(session, condition);
        },
      );
      const originalSummary = f.store.writeSummary.bind(f.store);
      vi.spyOn(TranscriptsStore.prototype, "writeSummary").mockImplementation(async (...args) => {
        if (fault === "summary-write" && cleanupFails) {
          throw new Error("summary write unavailable");
        }
        return originalSummary(...args);
      });
      stop.mockImplementation(async ({ sessionId }) => {
        if (cleanupFails && fault === "thrown-stop") {
          throw new Error("cleanup unavailable");
        }
        return { ok: true, sessionId };
      });
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        await service.start().settled;
        expect(readConfiguredTranscriptStarts(f.ctx.config.transcripts)?.get(0)?.diagnostic).toBe(
          "admitted-start-failed",
        );
        await vi.advanceTimersByTimeAsync(65_000);
        expect(readConfiguredTranscriptStarts(f.ctx.config.transcripts)?.get(0)?.diagnostic).toBe(
          "admitted-start-failed",
        );
        expect.soft(start).toHaveBeenCalledOnce();
        expect.soft(await f.store.listSessionEntries()).toHaveLength(1);
        expect
          .soft((await f.read()).configuredSources[0]?.startDiagnostic)
          .toBe("admitted-start-failed");
        const request = start.mock.calls.at(-1)![0];
        const session = request.session;
        await request.onUtterance({ text: "Late failed-start note", final: true });
        const terminal = fault === "summary-write";
        await expect(f.tool.execute("status", { action: "status" })).resolves.toMatchObject({
          details: {
            [terminal ? "pendingFinalization" : "active"]: [
              expect.objectContaining({ sessionId: session.sessionId }),
            ],
          },
        });
        const otherConfig = {
          transcripts: { autoStart: [{ ...room, sessionId: session.sessionId }] },
        };
        const other = createTranscriptsAutoStartService({ ...f.ctx, config: otherConfig });
        try {
          await other.start().settled;
          expect(
            (await readTranscriptLibraryStatus(f.store, otherConfig)).configuredSources[0]
              ?.startDiagnostic,
          ).toBe("id-conflict");
        } finally {
          await other.stop();
        }
        expect.soft(stop).toHaveBeenCalledOnce();
        await service.stop();
        cleanupFails = false;
        // A failed shutdown still owns cleanup; another stop drains that same owner.
        await service.stop();
        expect.soft(stop).toHaveBeenCalledTimes(terminal ? 1 : 3);
        expect.soft(activeSessions.has(session.sessionId)).toBe(false);
        const stored = (await f.store.readSession(session.sessionId))!;
        expect.soft(stored).toMatchObject({
          sessionId: session.sessionId,
          startedAt: session.startedAt,
          title: "Room title",
          stoppedAt: expect.any(String),
        });
        expect.soft(stored.source).toEqual(session.source);
        expect.soft(await f.store.readSummary(stored)).toMatchObject({
          summary: { transcript: ["Admitted note"] },
        });
      } finally {
        cleanupFails = false;
        await service.stop();
        for (const [request] of start.mock.calls) {
          await f.tool.execute("cleanup", { action: "stop", sessionId: request.session.sessionId });
        }
      }
    },
  );

  it.each(["queued", "pending", "manual"] as const)(
    "cancels generated retries after %s stop",
    async (mode) => {
      const pending = mode === "pending";
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture();
      const gate = createDeferred();
      const start = vi.fn(async (request: TranscriptStartRequest) => {
        if (start.mock.calls.length === 1) {
          return { ok: false as const, error: "temporary provider failure" };
        }
        await gate.promise;
        return { ok: true as const, session: request.session };
      });
      f.provider.start = start;
      const stop = vi.spyOn(f.provider, "stop");
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        await service.start().settled;
        expect(readConfiguredTranscriptStarts(f.ctx.config.transcripts)?.get(0)?.diagnostic).toBe(
          "retrying",
        );
        expect((await f.read()).configuredSources[0]?.startDiagnostic).toBe("retrying");
        if (pending) {
          await vi.advanceTimersByTimeAsync(5_000);
          await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2), { interval: 0 });
        }
        const session = start.mock.calls[0]![0].session;
        if (mode === "manual") {
          await f.tool.execute("stop", { action: "stop", sessionId: session.sessionId });
        } else {
          const stopping = service.stop();
          if (pending) {
            expect(start.mock.calls[1]![0].abortSignal?.aborted).toBe(true);
          }
          gate.resolve();
          await stopping;
        }
        const stoppedSession = await f.store.readSession(session.sessionId);
        gate.resolve();
        await vi.advanceTimersByTimeAsync(65_000);
        expect(start).toHaveBeenCalledTimes(pending ? 2 : 1);
        expect(stop).toHaveBeenCalledTimes(pending ? 1 : 0);
        for (const [request] of start.mock.calls) {
          await request.onUtterance({ text: "late cancelled note", final: true });
          await expect(f.store.readUtterancesForSession(request.session)).resolves.toEqual([]);
        }
        expect((await f.read()).active).toEqual([]);
        if (mode === "manual") {
          expect((await f.read()).configuredSources[0]?.startDiagnostic).toBe("id-conflict");
        } else {
          expect((await f.read()).configuredSources[0]).not.toHaveProperty("startDiagnostic");
        }
        expect(await f.store.readSession(session.sessionId)).toEqual(stoppedSession);
        expect(await f.store.listSessionEntries()).toHaveLength(1);
      } finally {
        gate.resolve();
        await service.stop();
      }
    },
  );

  it("rejects a duplicate fixed ID after its first capture ends without changing saved notes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    // Crossing midnight lets an accidental second capture create a distinct archive row.
    vi.setSystemTime(new Date("2026-09-05T23:59:58.000Z"));
    const entry = { ...room, sessionId: "daily" };
    const delayedId = "delayed-voice";
    const f = fixture({
      transcripts: { autoStart: [entry, { ...entry, providerId: delayedId }] },
    });
    const entered = createDeferred();
    const gate = createDeferred();
    const start = vi.fn(async (request: TranscriptStartRequest) => {
      entered.resolve();
      await gate.promise;
      return { ok: true as const, session: request.session };
    });
    const delayedStart = vi.fn(f.provider.start!);
    f.provider.start = start;
    const delayedProvider = { ...f.provider, id: delayedId, start: delayedStart };
    f.setProviders([f.provider]);
    const service = createTranscriptsAutoStartService(f.ctx);
    try {
      let settled = false;
      const starting = service.start().settled.then(() => {
        settled = true;
      });
      await entered.promise;
      expect(settled).toBe(false);
      expect((await f.read()).configuredSources[0]).toMatchObject({
        state: "unknown",
        startDiagnostic: "starting",
      });
      gate.resolve();
      await starting;
      expect((await f.read()).configuredSources).toMatchObject([
        { state: "armed" },
        { startDiagnostic: "retrying" },
      ]);
      const request = start.mock.calls[0]![0];
      await request.onUtterance({ text: "Saved before the duplicate retry", final: true });
      await request.onStatus!({ active: false });
      expect((await f.read()).active).toEqual([]);
      const session = (await f.store.readSession(entry.sessionId))!;
      expect(session.stoppedAt).toEqual(expect.any(String));
      const notes = await f.store.readSummary(session);
      expect(notes.summary?.transcript).toEqual(["Saved before the duplicate retry"]);
      const revision = await f.store.readSummaryInputRevision(session);
      f.setProviders([f.provider, delayedProvider]);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() =>
        expect(readConfiguredTranscriptStarts(f.ctx.config.transcripts)?.get(1)?.diagnostic).toBe(
          "id-conflict",
        ),
      );
      expect.soft((await f.read()).configuredSources[1]).toMatchObject({
        state: "not-active",
        startDiagnostic: "id-conflict",
        activeSelectors: [],
      });
      await vi.advanceTimersByTimeAsync(65_000);
      expect(start).toHaveBeenCalledOnce();
      expect(delayedStart).not.toHaveBeenCalled();
      expect(await f.store.listSessionEntries()).toHaveLength(1);
      expect(await f.store.readSession(entry.sessionId)).toEqual(session);
      expect(await f.store.readSummary(session)).toEqual(notes);
      expect(await f.store.readSummaryInputRevision(session)).toBe(revision);
    } finally {
      gate.resolve();
      await service.stop();
    }
  });

  it("fences late diagnostics and teardown against a replacement service and a manual capture", async () => {
    const f = fixture({ transcripts: { autoStart: [{ ...room, sessionId: "pending" }] } });
    const gate = createDeferred();
    const entered = createDeferred<TranscriptStartRequest>();
    f.provider.start = async (request) => {
      if (request.session.sessionId === "pending") {
        entered.resolve(request);
        await gate.promise;
      }
      return { ok: true, session: request.session };
    };
    const old = createTranscriptsAutoStartService(f.ctx);
    const config = { transcripts: { autoStart: [{ ...room, sessionId: "manual" }] } };
    const replacement = createTranscriptsAutoStartService({ ...f.ctx, config });
    try {
      const starting = old.start().settled;
      const pending = await entered.promise;
      const stopping = old.stop();
      expect(pending.abortSignal?.aborted).toBe(true);
      await f.start({ ...room, sessionId: "manual" });
      await replacement.start().settled;
      expect(
        (await readTranscriptLibraryStatus(f.store, config)).configuredSources[0]?.startDiagnostic,
      ).toBe("id-conflict");
      gate.resolve();
      await starting;
      await stopping;
      await old.stop();
      expect(
        (await readTranscriptLibraryStatus(f.store, config)).configuredSources[0]?.startDiagnostic,
      ).toBe("id-conflict");
      await pending.onUtterance({ text: "stale pending note" });
      await expect(f.store.readUtterancesForSession(pending.session)).resolves.toEqual([]);
      expect((await f.read()).active.map((s) => s.sessionId)).toEqual(["manual"]);
      await replacement.stop();
      expect((await f.read()).active.map((s) => s.sessionId)).toEqual(["manual"]);
    } finally {
      gate.resolve();
      await old.stop();
      await replacement.stop();
      await f.tool.execute("stop", { action: "stop", sessionId: "manual" });
    }
  });
  it("does not let an explicit configured URL capture arm an omitted locator", async () => {
    const source = { ...room, meetingUrl: "https://example.test/room" };
    const configured = { ...source, meetingUrl: undefined };
    const f = fixture({ transcripts: { autoStart: [configured] } });
    const sessionId = "configured";
    await f.start({ ...source, sessionId }, true);
    const result = await f.read();
    expect(result.configuredSources[0]).toMatchObject({
      state: "not-active",
      activeSelectors: [],
    });
    expect(result.active).toMatchObject([{ sessionId, activeSubscription: true }]);
    await f.tool.execute("stop", { action: "stop", sessionId });
  });

  it("requires complete manual identity and preserves exact explicit matching", async () => {
    const f = fixture();
    for (const configuredLifecycle of [undefined, true] as const) {
      const sessionId = configuredLifecycle ? "configured-exact" : "manual-exact";
      await f.start({ ...room, sessionId }, configuredLifecycle);
      const exact = await f.read();
      expect(exact.configuredSources[0]).toMatchObject({
        state: "armed",
        activeSelectors: [exact.active[0]!.selector],
      });
      for (const key of ["accountId", "guildId", "channelId"] as const) {
        const other = await readTranscriptLibraryStatus(f.store, {
          transcripts: { autoStart: [{ ...room, [key]: "other" }] },
        });
        expect(other.configuredSources[0]).toMatchObject({
          state: "not-active",
          activeSelectors: [],
        });
      }
      await f.tool.execute("stop", { action: "stop", sessionId });
    }
    await f.start({
      ...room,
      accountId: undefined,
      guildId: undefined,
      sessionId: "manual-default",
    });
    const result = await readTranscriptLibraryStatus(f.store, {
      transcripts: { autoStart: [{ ...room, accountId: undefined }] },
    });
    expect(result.configuredSources[0]).toMatchObject({ state: "unknown", activeSelectors: [] });
  });

  it("reports only its exact configured URL attempt and keeps changed invitations uncertain", async () => {
    const source = {
      ...room,
      meetingUrl: "https://example.test/room?invitation=synthetic-private",
    };
    const f = fixture({ transcripts: { autoStart: [source] } });
    const service = createTranscriptsAutoStartService(f.ctx);
    try {
      await service.start().settled;
      expect((await f.read()).configuredSources[0]?.state).toBe("armed");
      const changed = await readTranscriptLibraryStatus(f.store, {
        transcripts: {
          autoStart: [
            { ...source, meetingUrl: "https://example.test/room?invitation=other-private" },
          ],
        },
      });
      expect(changed.configuredSources[0]).toMatchObject({ state: "unknown", activeSelectors: [] });
      expect(changed.configuredSources[0]).not.toHaveProperty("startDiagnostic");
      expect(JSON.stringify([await f.read(), changed])).not.toMatch(
        /synthetic-private|other-private/,
      );
    } finally {
      await service.stop();
    }
  });

  it("retains only configured URL presence and never claims exact invitation identity", async () => {
    const url = new URL("https://example.test/room?invitation=synthetic-invite#synthetic-fragment");
    url.username = "synthetic-user";
    url.password = "synthetic-password";
    const source = { ...room, meetingUrl: url.href };
    const f = fixture({
      transcripts: { autoStart: [source, { ...source, meetingUrl: "https://example.test/room" }] },
    });
    await f.start({ ...source, sessionId: "url", privateMarker: "not-source-intent" }, true);
    const result = await f.read();
    expect(
      result.configuredSources.map(({ state, activeSelectors }) => ({ state, activeSelectors })),
    ).toEqual([
      { state: "unknown", activeSelectors: [] },
      { state: "unknown", activeSelectors: [] },
    ]);
    expect(result.active[0]?.activeSubscription).toBe(true);
    const snapshot = readTranscriptCaptureSnapshot();
    expect(snapshot[0]).toHaveProperty("configuredSource.meetingUrl", true);
    const retained = JSON.stringify([snapshot, await f.store.readSession("url"), result]);
    for (const privateText of ["synthetic-", "privateMarker", "not-source-intent"]) {
      expect(retained).not.toContain(privateText);
    }
  });

  it("keeps configured cleanup and in-flight stop owners unknown without transferring their evidence", async () => {
    const source = { ...room, accountId: undefined };
    const f = fixture({ transcripts: { autoStart: [source] } });
    const controller = new AbortController();
    f.provider.start = async ({ session }) => {
      controller.abort();
      return { ok: true, session };
    };
    f.provider.stop = async () => ({ ok: false, error: "cleanup pending" });
    await expect(
      startTranscripts({
        ctx: f.ctx,
        store: f.store,
        rawParams: { ...source, sessionId: "retained" },
        configuredLifecycle: true,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("provider cleanup failed");
    const retainedSession = await f.store.readSession("retained");
    expect(readTranscriptCaptureSnapshot()[0]).toHaveProperty(
      "configuredSource.accountId",
      undefined,
    );
    expect((await f.read()).configuredSources[0]).toMatchObject({
      state: "unknown",
      activeSelectors: [],
    });
    const stopGate = createDeferred();
    const stopping = createDeferred();
    f.provider.stop = async ({ sessionId }) => {
      stopping.resolve();
      await stopGate.promise;
      return { ok: true, sessionId };
    };
    const stopped = f.tool.execute("stop", { action: "stop", sessionId: "retained" });
    await stopping.promise;
    try {
      const result = await f.read();
      expect(result.configuredSources[0]).toMatchObject({ state: "unknown", activeSelectors: [] });
      expect(result.active[0]?.activeSubscription).toBe(false);
    } finally {
      stopGate.resolve();
      await stopped;
    }
    f.provider.start = async ({ session }) => ({ ok: true, session });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.parse(retainedSession!.startedAt) + 86_400_000));
    await f.start({ ...room, sessionId: "retained" });
    expect((await f.read()).configuredSources[0]).toMatchObject({
      state: "unknown",
      activeSelectors: [],
    });
  });
});

describe("configured transcript occupancy diagnostics", () => {
  it("joins an initially occupied capture while releasing its watcher before startup settles", async () => {
    const f = fixture({ transcripts: { autoStart: [{ ...room, whenOccupied: true }] } });
    const entered = createDeferred<TranscriptStartRequest>();
    const gate = createDeferred();
    const unwatched = createDeferred();
    f.provider.watchOccupancy = async (request) => {
      request.onOccupied();
      return { ok: true, value: { stop: () => unwatched.resolve() } };
    };
    f.provider.start = async (request) => {
      entered.resolve(request);
      await gate.promise;
      return { ok: true, session: request.session };
    };
    const service = createTranscriptsAutoStartService(f.ctx);
    try {
      let settled = false;
      const starting = service.start().settled.then(() => {
        settled = true;
      });
      const request = await entered.promise;
      expect(settled).toBe(false);
      const stopping = service.stop();
      await unwatched.promise;
      expect(request.abortSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      gate.resolve();
      await starting;
      await stopping;
      expect((await f.read()).active).toEqual([]);
    } finally {
      gate.resolve();
      await service.stop();
    }
  });

  it.each(["retrying", "starting", "reoccupied"] as const)(
    "settles a %s capture when its room becomes empty",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture({ transcripts: { autoStart: [{ ...room, whenOccupied: true }] } });
      const gate = createDeferred();
      const startCalled = createDeferred();
      const watch = vi.fn(async (request: TranscriptOccupancyWatchRequest) => {
        request.onOccupied();
        return { ok: true as const, value: { stop: vi.fn() } };
      });
      f.provider.watchOccupancy = watch;
      const start = vi.fn(async (request: TranscriptStartRequest) => {
        startCalled.resolve();
        if (start.mock.calls.length === 1) {
          if (mode === "retrying") {
            return { ok: false as const, error: "temporary capture failure" };
          }
          await gate.promise;
        }
        return { ok: true as const, session: request.session };
      });
      f.provider.start = start;
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        service.start();
        await startCalled.promise;
        expect(start).toHaveBeenCalledOnce();
        await vi.waitFor(async () =>
          expect((await f.read()).configuredSources[0]?.startDiagnostic).toBe(
            mode === "retrying" ? "retrying" : "starting",
          ),
        );
        const occupancy = watch.mock.calls[0]![0];
        occupancy.onEmpty();
        await vi.advanceTimersByTimeAsync(29_999);
        expect(start).toHaveBeenCalledOnce();
        if (mode !== "retrying") {
          expect(start.mock.calls[0]![0].abortSignal?.aborted).toBe(false);
        }
        await vi.advanceTimersByTimeAsync(1);
        if (mode !== "retrying") {
          expect(start.mock.calls[0]![0].abortSignal?.aborted).toBe(true);
        }
        if (mode === "reoccupied") {
          occupancy.onOccupied();
          expect(start).toHaveBeenCalledOnce();
        }
        gate.resolve();
        await vi.waitFor(async () =>
          expect((await f.read()).configuredSources[0]?.state).toBe(
            mode === "reoccupied" ? "armed" : "not-active",
          ),
        );
        expect((await f.read()).configuredSources[0]).not.toHaveProperty("startDiagnostic");
        await vi.advanceTimersByTimeAsync(65_000);
        expect(start).toHaveBeenCalledTimes(mode === "reoccupied" ? 2 : 1);
        expect((await f.read()).active).toHaveLength(mode === "reoccupied" ? 1 : 0);
      } finally {
        gate.resolve();
        await service.stop();
      }
    },
  );

  it.each(["unsupported", "guild-conflict", "empty"] as const)(
    "settles occupancy watcher retries after %s registration",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const entry = { ...room, whenOccupied: true };
      const entries =
        mode === "guild-conflict" ? [entry, { ...entry, channelId: "other-room" }] : [entry];
      const f = fixture({ transcripts: { autoStart: entries } });
      const watch = vi.fn(async (request: TranscriptOccupancyWatchRequest) => {
        if (mode === "guild-conflict") {
          request.onOccupied();
        }
        return { ok: true as const, value: { stop: vi.fn() } };
      });
      if (mode !== "unsupported") {
        f.provider.watchOccupancy = watch;
      }
      const start = vi.fn(f.provider.start!);
      f.provider.start = start;
      f.setProviders([]);
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        service.start();
        expect((await f.read()).configuredSources.map((source) => source.startDiagnostic)).toEqual(
          entries.map(() => "retrying"),
        );
        f.setProviders([f.provider]);
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(async () =>
          expect((await f.read()).configuredSources.map((source) => source.state)).toEqual(
            mode === "guild-conflict" ? ["armed", "not-active"] : ["not-active"],
          ),
        );
        expect(watch).toHaveBeenCalledTimes(mode === "unsupported" ? 0 : 1);
        expect(start).toHaveBeenCalledTimes(mode === "guild-conflict" ? 1 : 0);
        if (mode === "empty") {
          expect((await f.read()).configuredSources[0]).not.toHaveProperty("startDiagnostic");
          expect(await f.store.listSessionEntries()).toHaveLength(0);
          watch.mock.calls[0]![0].onOccupied();
          await vi.waitFor(async () =>
            expect((await f.read()).configuredSources[0]?.state).toBe("armed"),
          );
        } else {
          expect((await f.read()).configuredSources.at(-1)?.startDiagnostic).toBe("start-failed");
        }
        await vi.advanceTimersByTimeAsync(65_000);
        expect(watch).toHaveBeenCalledTimes(mode === "unsupported" ? 0 : 1);
        expect(start).toHaveBeenCalledTimes(mode === "unsupported" ? 0 : 1);
      } finally {
        await service.stop();
      }
    },
  );
});

it.each(["same date", "next date"] as const)(
  "reconciles a fixed ID on the %s after provider-selective stop",
  async (date) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const startedAt = Date.parse("2026-09-05T10:00:00.000Z");
    vi.setSystemTime(startedAt);
    const f = fixture({ transcripts: { autoStart: [{ ...room, sessionId: "daily" }] } });
    const start = vi.fn(f.provider.start!);
    f.provider.start = start;
    const service = createTranscriptsAutoStartService(f.ctx);
    try {
      await service.start().settled;
      expect((await f.read()).active).toHaveLength(1);
      const original = start.mock.calls[0]![0].session;
      await service.stop(new Set([room.providerId]));
      const selector = transcriptSessionSelector(original);
      const saved = await f.store.readSession(selector);
      f.ctx.logger.warn.mockClear();
      const write = vi.spyOn(TranscriptsStore.prototype, "writeSession");
      // A new admission has a new tuple even on the same date.
      vi.setSystemTime(startedAt + 60_000 + (date === "next date" ? 86_400_000 : 0));
      await service.start().settled;
      if (date === "same date") {
        expect.soft((await f.read()).configuredSources[0]?.startDiagnostic).toBe("id-conflict");
        await vi.advanceTimersByTimeAsync(65_000);
        expect(write).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expect(f.ctx.logger.warn).toHaveBeenCalledOnce();
        expect(f.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("id-conflict"));
      } else {
        expect((await f.read()).active).toHaveLength(1);
        expect(start).toHaveBeenCalledTimes(2);
        expect(write).toHaveBeenCalledOnce();
        expect(start.mock.calls[1]![0].session.startedAt).not.toBe(original.startedAt);
        expect(f.ctx.logger.warn).not.toHaveBeenCalled();
      }
      await expect(f.store.readSession(selector)).resolves.toEqual(saved);
    } finally {
      await service.stop();
    }
  },
);
