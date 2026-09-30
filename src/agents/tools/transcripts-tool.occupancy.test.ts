import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { createTranscriptsAutoStartService } from "../../transcripts/auto-start.js";
import { activeSessions, createTranscriptSessionId } from "../../transcripts/capture.js";
import * as transcriptCapture from "../../transcripts/capture.js";
import { clearTranscriptCapturesForTest } from "../../transcripts/capture.test-support.js";
import * as configuredStartStatus from "../../transcripts/configured-start-status.js";
import type {
  TranscriptOccupancyWatchRequest,
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { createTranscriptsTool } from "./transcripts-tool.js";

const tempDirs = createTempDirTracker();
const startTranscripts = transcriptCapture.startTranscripts;
const beginConfiguredTranscriptStarts = configuredStartStatus.beginConfiguredTranscriptStarts;
type Service = ReturnType<typeof createTranscriptsAutoStartService>;
afterEach(async () => {
  await clearTranscriptCapturesForTest();
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
  vi.restoreAllMocks();
});

function harness() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
  const stateDir = tempDirs.make("transcript-occupancy-");
  const requests: TranscriptStartRequest[] = [];
  const watches: TranscriptOccupancyWatchRequest[] = [];
  const unwatch = vi.fn();
  const logger = { warn: vi.fn() };
  const starts: ReturnType<typeof createDeferred<void>>[] = [];
  const retries: ReturnType<typeof createDeferred<void>>[] = [];
  const event = (events: typeof starts, count: number) => (events[count - 1] ??= createDeferred());
  let retryCount = 0;
  vi.spyOn(configuredStartStatus, "beginConfiguredTranscriptStarts").mockImplementation(
    (config) => {
      const owner = beginConfiguredTranscriptStarts(config);
      const record = owner.record.bind(owner);
      vi.spyOn(owner, "record").mockImplementation((...args) => {
        record(...args);
        if (args[2] === "retrying") {
          event(retries, ++retryCount).resolve();
        }
      });
      return owner;
    },
  );
  let completedStarts = 0;
  vi.spyOn(transcriptCapture, "startTranscripts").mockImplementation(async (params) => {
    const result = await startTranscripts(params);
    if (result.status === "active") {
      event(starts, ++completedStarts).resolve();
    }
    return result;
  });
  const provider: TranscriptSourceProvider = {
    id: "room-capture",
    name: "Room capture",
    sourceKinds: ["live-audio"],
    accessControl: {
      channelId: "room",
      resolveAccountId: ({ source }) => ({ ok: true, value: source.accountId ?? "default" }),
      authorize: async () => ({ ok: true, value: undefined }),
    },
    watchOccupancy: async (request) => {
      watches.push(request);
      return { ok: true, value: { stop: unwatch } };
    },
    start: vi.fn<NonNullable<TranscriptSourceProvider["start"]>>(async (request) => {
      requests.push(request);
      return { ok: true, session: request.session };
    }),
    stop: vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async ({ sessionId }) => ({
      ok: true,
      sessionId,
    })),
  };
  const entry = {
    providerId: provider.id,
    guildId: "guild",
    channelId: "voice",
    whenOccupied: true,
  };
  const registry = createEmptyPluginRegistry();
  registry.transcriptSourceProviders.push({
    pluginId: provider.id,
    provider,
    source: import.meta.url,
  });
  const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const service = (
    entries: NonNullable<NonNullable<OpenClawConfig["transcripts"]>["autoStart"]> = [entry],
    config: OpenClawConfig = {},
  ) =>
    createTranscriptsAutoStartService({
      stateDir,
      config: { ...config, transcripts: { autoStart: entries } },
      logger,
      caller: { kind: "operator", source: "scheduled" },
    });
  const run = (callback: (service: Service) => Promise<void>, instance = service()) =>
    withPluginRuntimeRegistryScope(registry, async () => {
      try {
        await callback(instance);
      } finally {
        await instance.stop();
      }
    });
  const started = async (count: number) => {
    await event(starts, count).promise;
    expect(requests).toHaveLength(count);
    const request = requests[count - 1]!;
    expect(activeSessions.get(request.session.sessionId)?.phase).toBe("active");
    return request;
  };
  const tool = (agentId = "main", config: OpenClawConfig = {}) =>
    createTranscriptsTool({
      stateDir,
      config,
      agentId,
      caller: { kind: "operator", source: "local" },
    });
  return {
    provider,
    entry,
    requests,
    watches,
    store,
    service,
    run,
    started,
    unwatch,
    tool,
    retrying: (count: number) => event(retries, count).promise,
  };
}

describe("occupancy-driven transcript lifecycle", () => {
  it("does not reopen a newest legacy capture or fall back to older generated history", async () => {
    const h = harness();
    const older = {
      sessionId: "older-generated",
      source: {
        providerId: h.provider.id,
        accountId: "default",
        guildId: "guild",
        channelId: "voice",
      },
      startedAt: "2026-08-01T11:40:00.000Z",
      stoppedAt: "2026-08-01T11:58:00.000Z",
      metadata: { sessionIdOrigin: "generated" },
    };
    const newest = {
      ...older,
      sessionId: createTranscriptSessionId(),
      startedAt: "2026-08-01T11:50:00.000Z",
      stoppedAt: "2026-08-01T11:59:00.000Z",
      metadata: {},
    };
    for (const session of [older, newest]) {
      await h.store.writeSession(session);
      await h.store.appendUtteranceForSession(session, { text: "Archived speech" });
    }
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await h.run(async (service) => {
      await service.start().settled;
      h.watches[0]!.onOccupied();
      const capture = await h.started(1);
      expect(capture.session.sessionId).not.toBe(newest.sessionId);
      expect(capture.session.sessionId).not.toBe(older.sessionId);
      expect(capture.session.metadata?.sessionIdOrigin).toBe("generated");
      await capture.onUtterance({ text: "Current speech" });
      expect(await h.store.readSession(older.sessionId)).toEqual(older);
      expect(await h.store.readSession(newest.sessionId)).toEqual(newest);
      expect(await h.store.readUtterancesForSession(newest)).toMatchObject([
        { text: "Archived speech" },
      ]);
    });
  });

  it("keeps admitted history with its original agent after the room is reassigned", async () => {
    const h = harness();
    const configFor = (agentId: string): OpenClawConfig => ({
      agents: { list: [{ id: "agent-a", default: true }, { id: "agent-b" }] },
      bindings: [{ agentId, match: { channel: "room", peer: { kind: "channel", id: "voice" } } }],
    });
    await h.run(
      async (first) => {
        await first.start().settled;
        h.watches[0]!.onOccupied();
        const original = await h.started(1);
        await original.onUtterance({ text: "Agent A's meeting" });
        await first.stop();
        const saved = await h.store.readSession(original.session.sessionId);
        const second = h.service([h.entry], configFor("agent-b"));
        try {
          await second.start().settled;
          h.watches[1]!.onOccupied();
          expect((await h.started(2)).session.sessionId).not.toBe(original.session.sessionId);
          expect(await h.store.readSession(original.session.sessionId)).toEqual(saved);
          const stops = vi.mocked(h.provider.stop!).mock.calls.length;
          for (const action of ["stop", "summarize"]) {
            await expect(
              h
                .tool("agent-b", configFor("agent-b"))
                .execute(action, { action, sessionId: original.session.sessionId }),
            ).rejects.toThrow("session not found");
          }
          expect(h.provider.stop).toHaveBeenCalledTimes(stops);
          expect(await h.store.readSession(original.session.sessionId)).toEqual(saved);
          await expect(
            h
              .tool("agent-a", configFor("agent-b"))
              .execute("summarize", { action: "summarize", sessionId: original.session.sessionId }),
          ).resolves.toMatchObject({ details: { sessionId: original.session.sessionId } });
        } finally {
          await second.stop();
        }
      },
      h.service([h.entry], configFor("agent-a")),
    );
  });

  it("retains one generated capture identity across continuous startup retries", async () => {
    const h = harness();
    const identities: Array<{ sessionId: string; startedAt: string }> = [];
    const entered = Array.from({ length: 3 }, () => createDeferred());
    h.provider.start = vi.fn<NonNullable<TranscriptSourceProvider["start"]>>(async (request) => {
      expect(request.session.metadata?.sessionIdOrigin).toBe("generated");
      identities.push(request.session);
      entered[identities.length - 1]!.resolve();
      if (identities.length < 3) {
        return { ok: false, error: "not ready" };
      }
      h.requests.push(request);
      return { ok: true, session: request.session };
    });
    const autoStart = [{ ...h.entry, whenOccupied: false }];
    await h.run(async (service) => {
      service.start();
      await entered[0]!.promise;
      for (let count = 1; count < 3; count++) {
        await h.retrying(count);
        expect(identities).toHaveLength(count);
        expect(
          configuredStartStatus.readConfiguredTranscriptStarts({ autoStart })?.get(0)?.diagnostic,
        ).toBe("retrying");
        await vi.advanceTimersByTimeAsync(5_000);
      }
      await entered[2]!.promise;
      await h.started(1);
      expect(
        new Set(identities.map(({ sessionId, startedAt }) => `${sessionId}/${startedAt}`)).size,
      ).toBe(1);
      expect(await h.store.listSessionEntries()).toHaveLength(1);
    }, h.service(autoStart));
  });

  it.each(["allowed", "denied"] as const)(
    "preserves failed-start retry authority through %s tool stop",
    async (stop) => {
      const h = harness();
      await h.run(async (service) => {
        const tool = h.tool();
        await tool.execute("initial", { action: "start", ...h.entry });
        const initial = h.requests[0]!;
        await initial.onUtterance({ text: "Preserved history" });
        await tool.execute("initial-stop", {
          action: "stop",
          sessionId: initial.session.sessionId,
        });
        const failed = createDeferred<TranscriptStartRequest>();
        h.provider.start = vi.fn<NonNullable<TranscriptSourceProvider["start"]>>(
          async (request) => {
            failed.resolve(request);
            return { ok: false, error: "not ready" };
          },
        );
        await service.start().settled;
        h.watches[0]!.onOccupied();
        const request = await failed.promise;
        await h.retrying(1);
        expect((await h.store.readSession(request.session.sessionId))?.stoppedAt).toBeDefined();
        const restored = await h.store.readSession(request.session.sessionId);
        const revision = await h.store.readSummaryInputRevision(request.session);
        if (stop === "denied") {
          h.provider.accessControl!.authorize = async () => ({ ok: false, error: "denied" });
        }
        const stopping = tool.execute("cancel-retry", {
          action: "stop",
          sessionId: request.session.sessionId,
        });
        if (stop === "allowed") {
          await stopping;
        } else {
          await expect(stopping).rejects.toThrow("session not found");
        }
        expect(await h.store.readSession(request.session.sessionId)).toEqual(restored);
        expect(await h.store.readSummaryInputRevision(request.session)).toBe(revision);
        const summary = await h.store.readSummary(request.session);
        h.provider.start = vi.fn<NonNullable<TranscriptSourceProvider["start"]>>(async (next) => {
          h.requests.push(next);
          return { ok: true, session: next.session };
        });
        await vi.advanceTimersByTimeAsync(5_000);
        if (stop === "allowed") {
          expect(h.provider.start).not.toHaveBeenCalled();
          expect(await h.store.readSession(request.session.sessionId)).toEqual(restored);
          h.watches[0]!.onEmpty();
          h.watches[0]!.onOccupied();
        }
        expect(await h.store.readSummary(request.session)).toEqual(summary);
        await request.onUtterance({ text: "Stale failure callback" });
        const reopened = await h.started(2);
        expect(reopened.session.sessionId).toBe(request.session.sessionId);
        expect(reopened.session.startedAt).toBe(request.session.startedAt);
        expect(await h.store.readUtterancesForSession(reopened.session)).toMatchObject([
          { text: "Preserved history" },
        ]);
      });
    },
  );

  it("reopens generated history within the gateway gap while preserving its admitted title", async () => {
    const h = harness();
    await h.run(
      async (first) => {
        await first.start().settled;
        h.watches[0]!.onOccupied();
        const original = await h.started(1);
        await original.onUtterance({ text: "Before restart" });
        await first.stop();
        await vi.advanceTimersByTimeAsync(60_000);
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        const second = h.service([{ ...h.entry, title: "Future meeting" }]);
        try {
          await second.start().settled;
          h.watches[1]!.onOccupied();
          const reopened = await h.started(2);
          expect(reopened.session.sessionId).toBe(original.session.sessionId);
          expect(reopened.session.startedAt).toBe(original.session.startedAt);
          expect(reopened.session.title).toBe("Original meeting");
          expect(reopened.session.stoppedAt).toBeUndefined();
          expect(reopened.session.metadata?.sessionIdOrigin).toBe("generated");
          await original.onUtterance({ text: "Stale callback" });
          await reopened.onUtterance({ text: "After restart" });
          await second.stop();
          expect(await h.store.readSummary(reopened.session)).toMatchObject({
            summary: { transcript: ["Before restart", "After restart"] },
          });
          expect(h.unwatch).toHaveBeenCalledTimes(2);
        } finally {
          await second.stop();
        }
      },
      h.service([{ ...h.entry, title: "Original meeting" }]),
    );
  });
});
