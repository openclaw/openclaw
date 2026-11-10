import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTranscriptsTool } from "../agents/tools/transcripts-tool.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { clearTranscriptCapturesForTest } from "../transcripts/capture.test-support.js";
import type { TranscriptStartRequest } from "../transcripts/provider-types.js";
import { TranscriptsStore } from "../transcripts/store.js";
import { MeetingTranscriptDeliveryError } from "./session-transcript-store.js";
import type { MeetingSessionRecord } from "./session-types.js";
import {
  createMeetingTranscriptSourceProvider,
  type MeetingDurableTranscriptBridge,
  type MeetingTranscriptBridgeLogger,
} from "./transcripts-bridge.js";
import { createMeetingDurableTranscriptBridge } from "./transcripts-bridge.runtime.js";

let stateDir: string;
let current: MeetingSessionRecord<"chrome", "agent">;
let bridge: MeetingDurableTranscriptBridge;
let store: TranscriptsStore;
let logger: MeetingTranscriptBridgeLogger;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-bridge-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  current = {
    id: "meeting-1",
    url: "https://meeting.example/room",
    transport: "chrome",
    mode: "agent",
    agentId: "research",
    state: "active",
    createdAt: "2026-07-23T12:00:00.000Z",
    updatedAt: "2026-07-23T12:00:00.000Z",
    participantIdentity: "OpenClaw browser guest",
    realtime: { enabled: true, toolPolicy: "safe-read-only" },
    notes: [],
  };
  logger = { warn: vi.fn() };
  bridge = createBridge();
  store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
});

afterEach(async () => {
  await bridge.stop(current, async () => {});
  await clearTranscriptCapturesForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await fs.rm(stateDir, { force: true, recursive: true });
  vi.unstubAllEnvs();
});

function createBridge(config?: { enabled: boolean }) {
  return createMeetingDurableTranscriptBridge({
    logger,
    options: { providerId: "meeting", providerName: "Meeting", stateDir, config },
  });
}

async function start(capture = async () => {}) {
  await bridge.start(current, capture);
}

function attachment(
  sessionId: string,
  callbacks: Partial<Pick<TranscriptStartRequest, "onUtterance" | "onStatus">> = {},
): TranscriptStartRequest {
  return {
    session: {
      sessionId,
      source: { providerId: "meeting", agentId: "research", meetingUrl: current.url },
      startedAt: current.createdAt,
    },
    onUtterance: vi.fn(),
    ...callbacks,
  };
}

it("retires simultaneous tool subscribers when meeting metadata finalization fails", async () => {
  const stopSource = vi.fn(bridge.detach.bind(bridge));
  const provider = createMeetingTranscriptSourceProvider({
    id: "meeting",
    name: "Meeting",
    runtime: async () => ({
      startTranscriptSource: async (request) => await bridge.attach(current, request),
      stopTranscriptSource: stopSource,
    }),
  });
  const registry = createEmptyPluginRegistry();
  registry.transcriptSourceProviders.push({ pluginId: "meeting", source: "test", provider });
  const tool = createTranscriptsTool({
    agentId: "research",
    caller: { kind: "operator", source: "local" },
  });
  const execute = (params: Record<string, unknown>) =>
    withPluginRuntimeRegistryScope(registry, () => tool.execute("meeting", params));
  const attach = (sessionId: string) =>
    execute({ action: "start", providerId: "meeting", meetingUrl: current.url, sessionId });
  await start();
  await bridge.ingest(current, [{ text: "existing note" }]);
  await attach("first-subscriber");
  await attach("second-subscriber");
  await execute({ action: "stop", sessionId: "first-subscriber" });
  await expect(execute({ action: "status" })).resolves.toMatchObject({
    details: { active: [{ sessionId: "second-subscriber" }] },
  });
  await attach("third-subscriber");
  const writeSession = store.writeSession.bind(store);
  const fault = vi
    .spyOn(TranscriptsStore.prototype, "writeSession")
    .mockImplementation(async (descriptor) => {
      if (descriptor.sessionId === current.id && descriptor.stoppedAt) {
        throw new Error("meeting metadata unavailable");
      }
      return await writeSession(descriptor);
    });
  const stopping = bridge.stop(current, async () => {
    await bridge.ingest(current, [{ text: "final note" }]);
  });
  await expect(stopping).rejects.toThrow("meeting metadata unavailable");
  fault.mockRestore();
  await vi.waitFor(async () => {
    for (const sessionId of ["second-subscriber", "third-subscriber"]) {
      const stored = await store.readSession(sessionId);
      expect(stored).toMatchObject({
        stoppedAt: expect.any(String),
        metadata: { agentId: "research" },
        source: { providerId: "meeting", agentId: "research" },
      });
      expect(stored && (await store.readSummary(stored))).toMatchObject({
        summary: { utteranceCount: 2 },
      });
    }
    await expect(execute({ action: "status" })).resolves.toMatchObject({
      details: { active: [], pendingFinalization: [] },
    });
  });
  expect(stopSource).toHaveBeenCalledOnce();
  await execute({ action: "stop", sessionId: "second-subscriber" });
  expect(stopSource).toHaveBeenCalledOnce();
});

it("replays stored lines to an attached provider and streams new lines in order", async () => {
  const onUtterance = vi.fn();
  const request = attachment("external-1", { onUtterance });
  await start();
  await bridge.ingest(current, [{ speaker: "Avery", text: "First line" }]);
  await expect(bridge.attach(current, request)).resolves.toMatchObject({ ok: true });
  await bridge.ingest(current, [{ speaker: "Blake", text: "Second line" }]);
  await expect(
    bridge.detach({
      ...request.session,
      source: { ...request.session.source, agentId: "another-agent" },
    }),
  ).resolves.toMatchObject({ ok: false });
  await expect(bridge.detach(request.session)).resolves.toMatchObject({ ok: true });
  const replayed = vi.fn();
  await expect(
    bridge.attach(current, { ...request, onUtterance: replayed }),
  ).resolves.toMatchObject({ ok: true });
  await bridge.stop(current, async () => {});

  expect(onUtterance.mock.calls.map(([utterance]) => utterance)).toMatchObject([
    { sessionId: "external-1", speaker: { label: "Avery" }, text: "First line" },
    { sessionId: "external-1", speaker: { label: "Blake" }, text: "Second line" },
  ]);
  expect(replayed.mock.calls.map(([utterance]) => utterance.id)).toEqual(
    onUtterance.mock.calls.map(([utterance]) => utterance.id),
  );
  const stored = await store.readSession(current.id);
  expect(await store.readSummary(stored!)).toMatchObject({
    summary: { utteranceCount: 2 },
  });
});

it("honors the existing global transcripts opt-out", async () => {
  bridge = createBridge({ enabled: false });
  await start();

  expect(bridge.enabled).toBe(false);
  await expect(bridge.attach(current, attachment("external-disabled"))).resolves.toMatchObject({
    ok: false,
  });
});

it("rolls back an attachment when its start status callback fails", async () => {
  await start();
  const request = attachment("external-status");

  await expect(
    bridge.attach(current, {
      ...request,
      onStatus: async () => {
        throw new Error("status delivery failed");
      },
    }),
  ).rejects.toThrow("status delivery failed");
  await expect(bridge.attach(current, request)).resolves.toMatchObject({ ok: true });
});

it("drains an in-flight periodic capture before the final capture", async () => {
  vi.useFakeTimers();
  const { promise: periodic, resolve: releasePeriodic } = createDeferredCore();
  const capture = vi
    .fn(async () => {})
    .mockResolvedValueOnce()
    .mockImplementationOnce(() => periodic);
  const finalCapture = vi.fn(async () => {});
  await start(capture);
  await vi.advanceTimersByTimeAsync(5_000);

  const stopping = bridge.stop(current, finalCapture);
  expect(finalCapture).not.toHaveBeenCalled();
  releasePeriodic();
  await expect(stopping).resolves.toBe(true);

  expect(finalCapture).toHaveBeenCalledOnce();
});

it("retries final durable delivery before completing the capture", async () => {
  const finalCapture = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new MeetingTranscriptDeliveryError(new Error("write failed")))
    .mockRejectedValueOnce(new MeetingTranscriptDeliveryError(new Error("write failed")))
    .mockResolvedValueOnce();
  await start();

  await expect(bridge.stop(current, finalCapture)).resolves.toBe(true);

  expect(finalCapture).toHaveBeenCalledTimes(3);
});

it("detaches a failing subscriber without blocking durable rows", async () => {
  const onUtterance = vi.fn(async () => {
    throw new Error("subscriber store unavailable");
  });
  await start();
  await bridge.attach(current, attachment("external-retry", { onUtterance }));

  await expect(bridge.ingest(current, [{ text: "first" }])).resolves.toBeUndefined();
  await expect(bridge.ingest(current, [{ text: "second" }])).resolves.toBeUndefined();

  const stored = await store.readSession(current.id);
  expect(await store.readUtterancesForSession(stored!)).toHaveLength(2);
  expect(onUtterance).toHaveBeenCalledOnce();
});

it("rejects attachments once finalization begins", async () => {
  const { promise: finalizing, resolve: releaseFinal } = createDeferredCore();
  await start();

  const stopping = bridge.stop(current, async () => await finalizing);
  await expect(bridge.attach(current, attachment("external-late"))).resolves.toMatchObject({
    ok: false,
  });
  releaseFinal();
  await expect(stopping).resolves.toBe(true);
});

it("drains subscriber delivery before detaching", async () => {
  const { promise: delivery, resolve: releaseDelivery } = createDeferredCore();
  const onStatus = vi.fn(async () => {});
  await start();
  const request = attachment("external-drain", { onStatus, onUtterance: () => delivery });
  await bridge.attach(current, request);
  const ingesting = bridge.ingest(current, [{ text: "pending delivery" }]);
  const detaching = bridge.detach(request.session);
  await Promise.resolve();
  expect(onStatus).toHaveBeenCalledTimes(1);
  releaseDelivery();
  await ingesting;
  await expect(detaching).resolves.toMatchObject({ ok: true });

  expect(onStatus).toHaveBeenCalledTimes(2);
});

it("does not let terminal subscriber notification block finalization", async () => {
  const onStatus = vi
    .fn()
    .mockReturnValueOnce(undefined)
    .mockImplementationOnce(() => {
      throw new Error("terminal status unavailable");
    });
  await start();
  await bridge.attach(current, attachment("external-terminal", { onStatus }));

  await expect(bridge.stop(current, async () => {})).resolves.toBe(true);

  expect(onStatus).toHaveBeenCalledTimes(2);
});

it("queues detach behind a pending attachment replay", async () => {
  const { promise: replay, resolve: releaseReplay } = createDeferredCore();
  const onUtterance = vi.fn(async () => await replay);
  await start();
  await bridge.ingest(current, [{ text: "existing row" }]);
  const request = attachment("external-pending", { onUtterance });

  const attaching = bridge.attach(current, request);
  const detaching = bridge.detach(request.session);
  releaseReplay();
  await expect(attaching).resolves.toMatchObject({ ok: true });
  await expect(detaching).resolves.toMatchObject({ ok: true });
  await bridge.ingest(current, [{ text: "after detach" }]);

  expect(onUtterance).toHaveBeenCalledOnce();
});

it("records a non-blocking final browser snapshot failure", async () => {
  await start();

  await expect(
    bridge.stop(current, async () => {
      throw new Error("");
    }),
  ).resolves.toBe(true);

  await expect(store.readSession(current.id)).resolves.toMatchObject({
    metadata: {
      finalCaptureError: "",
      sessionIdOrigin: "supplied",
      finalCaptureFailedAt: expect.any(String),
    },
    stoppedAt: expect.any(String),
  });
});
