import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { retainPreparedPluginRegistry } from "../agents/prepared-model-runtime.plugin-lifetime.js";
import { createTranscriptsTool } from "../agents/tools/transcripts-tool.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { PluginInvocationScope } from "../plugins/plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { bindPluginRegistryResourceOwner } from "../plugins/registry-lifecycle.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createTranscriptsAutoStartService } from "./auto-start.js";
import { prepareTranscriptCaptureDisable } from "./capture-operations.js";
import type { TranscriptSourceProvider, TranscriptStartRequest } from "./provider-types.js";
import {
  transcriptStatusRoom as room,
  useTranscriptStatusFixture,
} from "./status.producer.test-harness.js";
import { TranscriptsStore } from "./store.js";

const tempDirs = createTempDirTracker();
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("transcript provider cleanup custody", () => {
  it.each([
    { owner: "service", failure: "returned", registryChange: "none" },
    { owner: "service", failure: "thrown", registryChange: "none" },
    { owner: "manual-service", failure: "returned", registryChange: "none" },
    { owner: "tool", failure: "returned", registryChange: "removed" },
    { owner: "tool", failure: "thrown", registryChange: "replaced" },
  ] as const)(
    "retains $owner cleanup after a $failure failure with provider $registryChange",
    async ({ owner, failure, registryChange }) => {
      const stateDir = tempDirs.make("transcript-stop-custody-");
      const requests: TranscriptStartRequest[] = [];
      const registered = createDeferred();
      let subscribed = false;
      let failing = true;
      const stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async ({ sessionId }) => {
        if (failing) {
          if (failure === "thrown") {
            throw new Error("cleanup unavailable");
          }
          return { ok: false, error: "cleanup unavailable" };
        }
        subscribed = false;
        return { ok: true, sessionId };
      });
      const provider: TranscriptSourceProvider = {
        id: "cleanup-capture",
        name: "Cleanup capture",
        sourceKinds: ["live-caption"],
        start: async (request) => {
          requests.push(request);
          subscribed = true;
          registered.resolve();
          return { ok: true, session: request.session };
        },
        stop,
      };
      const registry = createEmptyPluginRegistry();
      const registration = { pluginId: provider.id, provider, source: import.meta.url };
      registry.transcriptSourceProviders.push(registration);
      const ctx = {
        stateDir,
        agentId: "main",
        config: {
          plugins: { enabled: true },
          transcripts: { autoStart: [{ providerId: provider.id, sessionId: "notes" }] },
        },
        logger: { warn: vi.fn() },
        caller: { kind: "operator" as const, source: "local" as const },
      };
      const tool = createTranscriptsTool(ctx);
      const service = createTranscriptsAutoStartService(ctx);
      const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const replacementStop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(
        async ({ sessionId }) => ({ ok: true, sessionId }),
      );
      await withPluginRuntimeRegistryScope(registry, async () => {
        try {
          if (owner !== "tool") {
            service.start();
            await registered.promise;
            await vi.waitFor(async () =>
              expect(await tool.execute("status", { action: "status" })).toMatchObject({
                details: { active: [{ sessionId: "notes" }] },
              }),
            );
          } else {
            await tool.execute("start", {
              action: "start",
              providerId: provider.id,
              sessionId: "notes",
            });
          }
          const request = requests[0]!;
          await request.onUtterance({ text: "Saved before stop" });
          if (owner === "service") {
            await service.stop();
            expect
              .soft(ctx.logger.warn)
              .toHaveBeenCalledWith(expect.stringMatching(/stop failed.*cleanup unavailable/));
          } else {
            await expect
              .soft(tool.execute("stop", { action: "stop", sessionId: "notes" }))
              .rejects.toThrow("cleanup unavailable");
          }
          expect.soft(subscribed).toBe(true);
          await expect.soft(tool.execute("status", { action: "status" })).resolves.toMatchObject({
            details: {
              active: [{ sessionId: "notes", cleanupPending: true }],
              pendingFinalization: [],
            },
          });
          expect.soft((await store.readSession("notes"))?.stoppedAt).toBeUndefined();
          await request.onUtterance({ text: "Too late after failed stop" });
          expect
            .soft((await store.readUtterancesForSession(request.session)).map((line) => line.text))
            .toEqual(["Saved before stop"]);
          if (registryChange === "removed") {
            ctx.config.plugins.enabled = false;
            registry.transcriptSourceProviders.splice(0);
          } else if (registryChange === "replaced") {
            registry.transcriptSourceProviders[0] = {
              ...registration,
              provider: { ...provider, stop: replacementStop },
            };
          }
          failing = false;
          if (owner !== "tool") {
            await service.stop();
          } else {
            await tool.execute("retry-stop", { action: "stop", sessionId: "notes" });
          }
          expect.soft(stop).toHaveBeenCalledTimes(2);
          expect.soft(replacementStop).not.toHaveBeenCalled();
          expect.soft(subscribed).toBe(false);
          await expect(tool.execute("status", { action: "status" })).resolves.toMatchObject({
            details: { active: [], pendingFinalization: [] },
          });
          expect((await store.readSummary(request.session)).summary?.transcript).toEqual([
            "Saved before stop",
          ]);
        } finally {
          failing = false;
          ctx.config.plugins.enabled = true;
          registry.transcriptSourceProviders.splice(
            0,
            registry.transcriptSourceProviders.length,
            registration,
          );
          await service.stop();
          if (requests.length) {
            await tool.execute("cleanup", { action: "stop", sessionId: "notes" });
          }
        }
      });
    },
  );
});

describe("live transcript capture policy", () => {
  const fixture = useTranscriptStatusFixture();
  it("checks a revoked account against current config through a previously created tool", async () => {
    const config = {
      transcripts: { enabled: true },
      channels: { discord: { accounts: { work: { enabled: true } } } },
    };
    setRuntimeConfigSnapshot(config);
    const f = fixture(config);
    const authorize = vi.fn<NonNullable<TranscriptSourceProvider["accessControl"]>["authorize"]>(
      async ({ cfg }) =>
        cfg?.channels?.discord?.accounts?.work?.enabled === false
          ? { ok: false, error: "capture account disabled" }
          : { ok: true, value: undefined },
    );
    f.provider.accessControl!.authorize = authorize;
    const start = vi.spyOn(f.provider, "start");
    const current = {
      ...config,
      channels: { discord: { accounts: { work: { enabled: false } } } },
    };
    setRuntimeConfigSnapshot(current);

    await expect(f.tool.execute("retained-tool", { action: "start", ...room })).rejects.toThrow(
      "capture account disabled",
    );
    expect(authorize.mock.calls[0]?.[0].cfg).toBe(current);
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["starting", "active"] as const)(
    "disables a %s tool capture after draining accepted speech and fences its retained tool",
    async (phase) => {
      const config = { transcripts: { enabled: true } };
      setRuntimeConfigSnapshot(config);
      const f = fixture(config);
      const started = createDeferred<TranscriptStartRequest>();
      const releaseStart = createDeferred();
      const appendEntered = createDeferred();
      const releaseAppend = createDeferred();
      const stop = vi.fn<NonNullable<typeof f.provider.stop>>(async ({ sessionId }) => ({
        ok: true,
        sessionId,
      }));
      f.provider.stop = stop;
      f.provider.start = async (request) => {
        started.resolve(request);
        await releaseStart.promise;
        return { ok: true, session: request.session };
      };
      const append = f.store.appendUtteranceForSession.bind(f.store);
      vi.spyOn(f.store, "appendUtteranceForSession").mockImplementation(async (...args) => {
        appendEntered.resolve();
        await releaseAppend.promise;
        return append(...args);
      });
      const startup = f.start({ ...room, sessionId: "policy-capture" }).then(
        (result) => result,
        (error: unknown) => error,
      );
      const request = await Promise.race([
        started.promise,
        startup.then((result) => {
          if (result instanceof Error) {
            throw result;
          }
          throw new Error("Capture startup settled without entering the fixture provider");
        }),
      ]);
      if (phase === "active") {
        releaseStart.resolve();
        await startup;
      }
      const accepted = Promise.resolve(request.onUtterance({ text: "Accepted before disable" }));
      await appendEntered.promise;
      const disabled = { transcripts: { enabled: false } };
      const policy = prepareTranscriptCaptureDisable(f.ctx.stateDir);
      const drained = policy.drain();
      try {
        await expect(
          f.tool.execute("start-during-drain", { action: "start", ...room }),
        ).rejects.toThrow("transcripts are disabled");
        await request.onUtterance({ text: "Speech after disable" });
        expect(await f.store.readUtterancesForSession(request.session)).toEqual([]);
        releaseStart.resolve();
        releaseAppend.resolve();
        await Promise.all([accepted, startup, drained]);
        if (phase === "starting") {
          expect(await startup).toBeInstanceOf(Error);
        }
        expect(stop).toHaveBeenCalledOnce();
        expect(await f.store.readSummary(request.session)).toMatchObject({
          summary: { transcript: ["Accepted before disable"] },
        });
        expect((await f.store.readSession(request.session.sessionId))?.stoppedAt).toEqual(
          expect.any(String),
        );
        setRuntimeConfigSnapshot(disabled);
        policy.resume();
        await expect(f.tool.execute("retained-tool", { action: "start", ...room })).rejects.toThrow(
          "transcripts are disabled",
        );
        setRuntimeConfigSnapshot(config);
        await expect(
          f.tool.execute("reenabled-tool", { action: "start", ...room, sessionId: "reenabled" }),
        ).resolves.toMatchObject({ details: { sessionId: "reenabled" } });
        await f.tool.execute("cleanup", { action: "stop", sessionId: "reenabled" });
      } finally {
        releaseStart.resolve();
        releaseAppend.resolve();
        await Promise.allSettled([accepted, startup, drained]);
        policy.resume();
      }
    },
  );

  it("leaves configured capture cleanup with its auto-start owner", async () => {
    const f = fixture();
    const stop = vi.fn(f.provider.stop!);
    f.provider.stop = stop;
    await f.start({ ...room, sessionId: "configured" }, true);
    const policy = prepareTranscriptCaptureDisable(f.ctx.stateDir);
    try {
      await policy.drain();
      expect(stop).not.toHaveBeenCalled();
      expect((await f.store.readSession("configured"))?.stoppedAt).toBeUndefined();
    } finally {
      policy.resume();
      await f.tool.execute("cleanup", { action: "stop", sessionId: "configured" });
    }
  });

  it("joins an in-flight user stop without stopping the provider twice", async () => {
    const f = fixture();
    const start = vi.spyOn(f.provider, "start");
    const stopping = createDeferred();
    const releaseStop = createDeferred();
    const stop = vi.fn<NonNullable<typeof f.provider.stop>>(async ({ sessionId }) => {
      await start.mock.calls[0]![0].onStatus?.({ active: false, sessionId });
      stopping.resolve();
      await releaseStop.promise;
      return { ok: true, sessionId };
    });
    f.provider.stop = stop;
    await f.start({ ...room, sessionId: "user-stopping" });
    const userStop = f.tool.execute("stop", { action: "stop", sessionId: "user-stopping" });
    await stopping.promise;
    const policy = prepareTranscriptCaptureDisable(f.ctx.stateDir);
    let drainComplete = false;
    const drained = policy.drain().then(() => {
      drainComplete = true;
    });
    try {
      expect((await f.store.readSession("user-stopping"))?.stoppedAt).toEqual(expect.any(String));
      expect(drainComplete).toBe(false);
      releaseStop.resolve();
      await Promise.all([userStop, drained]);
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      releaseStop.resolve();
      await Promise.allSettled([userStop, drained]);
      policy.resume();
    }
  });

  it("keeps each state directory fenced until its preparation resumes", async () => {
    const first = fixture();
    const second = fixture();
    const policies = [first, second].map((f) => prepareTranscriptCaptureDisable(f.ctx.stateDir));
    try {
      for (const f of [first, second]) {
        await expect(f.tool.execute("start", { action: "start", ...room })).rejects.toThrow(
          "transcripts are disabled",
        );
      }
      policies[0]!.resume();
      await expect(first.tool.execute("status", { action: "status" })).resolves.toMatchObject({
        details: { active: [] },
      });
      await expect(second.tool.execute("start", { action: "start", ...room })).rejects.toThrow(
        "transcripts are disabled",
      );
    } finally {
      for (const policy of policies) {
        policy.resume();
      }
    }
  });
});

it.each([
  { source: "inspection", retry: false },
  { source: "inspection", retry: true },
  { source: "prepared", retry: false },
  { source: "prepared", retry: true },
] as const)(
  "keeps a tool capture's $source source after its agent closes (cleanup retry: $retry)",
  async ({ source, retry }) => {
    const stateDir = tempDirs.make("transcript-source-retention-");
    const owner = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "retained-captions",
      source: import.meta.url,
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    owner.registry.plugins.push(record);
    const api = owner.createApi(record, { config: {} });
    const instance = getPluginInstance(record)!;
    const disposed = vi.fn();
    instance.lifecycle.onDispose(disposed);
    let request: TranscriptStartRequest | undefined;
    let failStop = retry;
    const stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async ({ sessionId }) => {
      if (failStop) {
        throw new Error("caption transport stop failed");
      }
      await request!.onStatus?.({ active: false, sessionId });
      return { ok: true, sessionId };
    });
    api.registerTranscriptSourceProvider({
      id: record.id,
      name: "Retained captions",
      sourceKinds: ["live-caption"],
      async start(start) {
        request = start;
        return { ok: true, session: start.session };
      },
      stop,
    });
    const siblingRecord = createPluginRecord({
      ...record,
      id: "unrelated-captions",
      configSchema: false,
    });
    owner.registry.plugins.push(siblingRecord);
    owner.createApi(siblingRecord, { config: {} }).registerTranscriptSourceProvider({
      id: siblingRecord.id,
      aliases: [record.id],
      name: "Unrelated captions",
      sourceKinds: ["live-caption"],
      async start() {
        throw new Error("The unrelated source must not start");
      },
    });
    const sibling = getPluginInstance(siblingRecord)!;
    let releaseRegistry: () => void | Promise<void>;
    const registry =
      source === "prepared"
        ? bindPluginRegistryResourceOwner({ ...owner.registry }, owner.registry)
        : owner.registry;
    if (source === "inspection") {
      const resources = new PluginRegistryInspectionResources(async () => {
        for (const captureInstance of [instance, sibling]) {
          const result = await captureInstance.dispose();
          if (result.errors.length) {
            throw new AggregateError(result.errors, "Caption source disposal failed");
          }
        }
      });
      resources.attach(registry);
      releaseRegistry = () => resources.release();
    } else {
      const release = retainPreparedPluginRegistry(registry);
      if (!release) {
        throw new Error("Expected the prepared runtime to own its source registry");
      }
      releaseRegistry = release;
    }
    const agent = new PluginInvocationScope(registry, [instance, sibling], { retained: true });
    const config = { transcripts: { enabled: true } };
    const tool = createTranscriptsTool({
      config,
      stateDir,
      caller: { kind: "operator", source: "local" },
    });
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    let disabled: ReturnType<typeof prepareTranscriptCaptureDisable> | undefined;
    let releaseReplacement: (() => void) | undefined;
    try {
      await withPluginRuntimeRegistryScope(registry, () =>
        agent.run(() =>
          tool.execute("start", {
            action: "start",
            providerId: record.id,
            sessionId: "retained-capture",
          }),
        ),
      );
      agent.release();
      await releaseRegistry();
      expect(disposed).not.toHaveBeenCalled();
      sibling.reserveReplacement()();
      expect(sibling.retainedWorkCount).toBe(0);
      releaseReplacement = instance.reserveReplacement();
      expect(instance.retainedWorkCount).toBeGreaterThan(0);
      await request!.onUtterance({ text: "Speech after the agent turn finished" });
      disabled = prepareTranscriptCaptureDisable(stateDir);
      if (retry) {
        await expect(disabled.drain()).rejects.toThrow("Transcript capture policy drainage failed");
        expect(disposed).not.toHaveBeenCalled();
        expect(instance.retainedWorkCount).toBeGreaterThan(0);
        failStop = false;
      }
      await disabled.drain();
      expect(stop).toHaveBeenCalledTimes(retry ? 2 : 1);
      expect(disposed).toHaveBeenCalledOnce();
      expect(instance.retainedWorkCount).toBe(0);
      expect(await store.readSummary(request!.session)).toMatchObject({
        summary: { transcript: ["Speech after the agent turn finished"] },
      });
      expect((await store.readSession("retained-capture"))?.stoppedAt).toEqual(expect.any(String));
    } finally {
      releaseReplacement?.();
      failStop = false;
      agent.release();
      disabled ??= prepareTranscriptCaptureDisable(stateDir);
      await disabled.drain();
      disabled.resume();
      await releaseRegistry();
    }
  },
);
