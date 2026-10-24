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
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { bindPluginRegistryResourceOwner } from "../plugins/registry-lifecycle.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { withPluginRuntimeRegistryScope as withRegistry } from "../plugins/runtime/gateway-request-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createTranscriptsAutoStartService } from "./auto-start.js";
import { prepareTranscriptCaptureDisable as prepareDisable } from "./capture-startup.js";
import type {
  TranscriptSourceProvider as Provider,
  TranscriptStartRequest as Start,
} from "./provider-types.js";
import {
  transcriptStatusRoom as room,
  useTranscriptStatusFixture,
} from "./status.producer.test-harness.js";
import { TranscriptsStore } from "./store.js";

const tempDirs = createTempDirTracker();
const stopSuccessfully: NonNullable<Provider["stop"]> = async ({ sessionId }) => ({
  ok: true,
  sessionId,
});
function captureActions(tool: NonNullable<ReturnType<typeof createTranscriptsTool>>) {
  return {
    start: (params: Record<string, unknown>) =>
      tool.execute("start", { action: "start", ...params }),
    stop: (sessionId: string) => tool.execute("stop", { action: "stop", sessionId }),
    status: async () => (await tool.execute("status", { action: "status" })).details,
  };
}
function captureTools(stateDir: string, options: Parameters<typeof createTranscriptsTool>[0]) {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return {
    ...captureActions(createTranscriptsTool(options)),
    store: new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    }),
  };
}
const expectDisabled = (tool: Pick<ReturnType<typeof captureTools>, "start">) =>
  expect(tool.start(room)).rejects.toThrow("transcripts are disabled");

type StopFailure = "returned" | "thrown";
function retryingProvider(id: string, error: string, failure: StopFailure, reportStopped = false) {
  const requests: Start[] = [];
  const registered = createDeferred();
  const state = { subscribed: false, failing: true };
  const stop = vi.fn<NonNullable<Provider["stop"]>>(async ({ sessionId }) => {
    if (state.failing) {
      if (failure === "thrown") {
        throw new Error(error);
      }
      return { ok: false, error };
    }
    state.subscribed = false;
    if (reportStopped) {
      await requests[0]!.onStatus?.({ active: false, sessionId });
    }
    return { ok: true, sessionId };
  });
  const provider: Provider = {
    id,
    name: id,
    sourceKinds: ["live-caption"],
    stop,
    async start(request) {
      requests.push(request);
      state.subscribed = true;
      registered.resolve();
      return { ok: true, session: request.session };
    },
  };
  return { provider, requests, registered, state, stop };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

describe("transcript provider cleanup custody", () => {
  const fixture = useTranscriptStatusFixture();
  it.each([
    { owner: "service", failure: "returned", registryChange: "none" },
    { owner: "manual-service", failure: "returned", registryChange: "none" },
    { owner: "tool", failure: "returned", registryChange: "removed" },
    { owner: "tool", failure: "thrown", registryChange: "replaced" },
  ] as const)(
    "retains $owner cleanup after a $failure failure with provider $registryChange",
    async ({ owner, failure, registryChange }) => {
      const { provider, requests, registered, state, stop } = retryingProvider(
        "cleanup-capture",
        "cleanup unavailable",
        failure,
      );
      const f = fixture({
        plugins: { enabled: true },
        transcripts: { autoStart: [{ providerId: provider.id, sessionId: "notes" }] },
      });
      f.setProviders([provider]);
      const { ctx, store } = f;
      const tool = captureActions(f.tool);
      const service = createTranscriptsAutoStartService({
        ...ctx,
        caller: { kind: "operator", source: "local" },
      });
      const replacementStop = vi.fn(stopSuccessfully);
      try {
        if (owner !== "tool") {
          service.start();
          await registered.promise;
          await vi.waitFor(async () =>
            expect(await tool.status()).toMatchObject({ active: [{ sessionId: "notes" }] }),
          );
        } else {
          await tool.start({ providerId: provider.id, sessionId: "notes" });
        }
        const request = requests[0]!;
        await request.onUtterance({ text: "Saved before stop" });
        if (owner === "service") {
          await service.stop();
          expect
            .soft(ctx.logger.warn)
            .toHaveBeenCalledWith(expect.stringMatching(/stop failed.*cleanup unavailable/));
        } else {
          await expect.soft(tool.stop("notes")).rejects.toThrow("cleanup unavailable");
        }
        expect.soft(state.subscribed).toBe(true);
        await expect.soft(tool.status()).resolves.toMatchObject({
          active: [{ sessionId: "notes", cleanupPending: true }],
          pendingFinalization: [],
        });
        expect.soft((await store.readSession("notes"))?.stoppedAt).toBeUndefined();
        await request.onUtterance({ text: "Too late after failed stop" });
        expect
          .soft((await store.readUtterancesForSession(request.session)).map((line) => line.text))
          .toEqual(["Saved before stop"]);
        if (registryChange === "removed") {
          ctx.config.plugins!.enabled = false;
          f.setProviders([]);
        } else if (registryChange === "replaced") {
          f.setProviders([{ ...provider, stop: replacementStop }]);
        }
        state.failing = false;
        await (owner !== "tool" ? service.stop() : tool.stop("notes"));
        expect.soft(stop).toHaveBeenCalledTimes(2);
        expect.soft(replacementStop).not.toHaveBeenCalled();
        expect.soft(state.subscribed).toBe(false);
        await expect(tool.status()).resolves.toMatchObject({
          active: [],
          pendingFinalization: [],
        });
        expect((await store.readSummary(request.session)).summary?.transcript).toEqual([
          "Saved before stop",
        ]);
      } finally {
        state.failing = false;
        ctx.config.plugins!.enabled = true;
        f.setProviders([provider]);
        await service.stop();
        if (requests.length) {
          await tool.stop("notes");
        }
      }
    },
  );
});

describe("live transcript capture policy", () => {
  const makeFixture = useTranscriptStatusFixture();
  const fixture = (config?: Parameters<typeof makeFixture>[0]) => {
    const f = makeFixture(config);
    return { ...f, actions: captureActions(f.tool) };
  };
  it("checks a revoked account against current config through a previously created tool", async () => {
    const config = {
      transcripts: { enabled: true },
      channels: { discord: { accounts: { work: { enabled: true } } } },
    };
    setRuntimeConfigSnapshot(config);
    const f = fixture(config);
    const authorize = vi.fn<NonNullable<Provider["accessControl"]>["authorize"]>(async ({ cfg }) =>
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

    await expect(f.actions.start(room)).rejects.toThrow("capture account disabled");
    expect(authorize.mock.calls[0]?.[0].cfg).toBe(current);
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["starting", "active"] as const)(
    "disables a %s tool capture after draining accepted speech and fences its retained tool",
    async (phase) => {
      const config = { transcripts: { enabled: true } };
      setRuntimeConfigSnapshot(config);
      const f = fixture(config);
      const started = createDeferred<Start>();
      const releaseStart = createDeferred();
      const appendEntered = createDeferred();
      const releaseAppend = createDeferred();
      const stop = vi.fn(stopSuccessfully);
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
      const startup = f
        .start({ ...room, sessionId: "policy-capture" })
        .catch((error: unknown) => error);
      const request = await Promise.race([
        started.promise,
        startup.then((result) => {
          throw result instanceof Error
            ? result
            : new Error("Capture startup settled without entering the fixture provider");
        }),
      ]);
      if (phase === "active") {
        releaseStart.resolve();
        await startup;
      }
      const accepted = Promise.resolve(request.onUtterance({ text: "Accepted before disable" }));
      await appendEntered.promise;
      const disabled = { transcripts: { enabled: false } };
      const policy = prepareDisable(f.ctx.stateDir);
      const drained = policy.drain();
      try {
        await expectDisabled(f.actions);
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
        await expectDisabled(f.actions);
        setRuntimeConfigSnapshot(config);
        await expect(f.actions.start({ ...room, sessionId: "reenabled" })).resolves.toMatchObject({
          details: { sessionId: "reenabled" },
        });
        await f.actions.stop("reenabled");
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
    const policy = prepareDisable(f.ctx.stateDir);
    try {
      await policy.drain();
      expect(stop).not.toHaveBeenCalled();
      expect((await f.store.readSession("configured"))?.stoppedAt).toBeUndefined();
    } finally {
      policy.resume();
      await f.actions.stop("configured");
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
    const userStop = f.actions.stop("user-stopping");
    await stopping.promise;
    const policy = prepareDisable(f.ctx.stateDir);
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
    const policies = [first, second].map((f) => prepareDisable(f.ctx.stateDir));
    try {
      for (const f of [first, second]) {
        await expectDisabled(f.actions);
      }
      policies[0]!.resume();
      await expect(first.actions.status()).resolves.toMatchObject({ active: [] });
      await expectDisabled(second.actions);
    } finally {
      for (const policy of policies) {
        policy.resume();
      }
    }
  });
});

it.each(["inspection", "prepared"] as const)(
  "keeps a tool capture's %s source through cleanup retry after its agent closes",
  async (source) => {
    const stateDir = tempDirs.make("transcript-source-retention-");
    const owner = createTestPluginRegistry();
    const register = (provider: Provider) => {
      const record = createPluginRecord({
        id: provider.id,
        source: import.meta.url,
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      owner.registry.plugins.push(record);
      owner.createApi(record, { config: {} }).registerTranscriptSourceProvider(provider);
      return getPluginInstance(record)!;
    };
    const { provider, requests, state, stop } = retryingProvider(
      "retained-captions",
      "caption transport stop failed",
      "thrown",
      true,
    );
    const instance = register(provider);
    const disposed = vi.fn();
    instance.lifecycle.onDispose(disposed);
    const sibling = register({
      id: "unrelated-captions",
      name: "Unrelated captions",
      sourceKinds: ["live-caption"],
      aliases: [provider.id],
      async start() {
        throw new Error("The unrelated source must not start");
      },
    });
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
    const tool = captureTools(stateDir, {
      config: { transcripts: { enabled: true } },
      caller: { kind: "operator", source: "local" },
    });
    const { store } = tool;
    let disabled: ReturnType<typeof prepareDisable> | undefined;
    try {
      await withRegistry(registry, () =>
        agent.run(() => tool.start({ providerId: provider.id, sessionId: "retained-capture" })),
      );
      const request = requests[0]!;
      agent.release();
      await releaseRegistry();
      expect(disposed).not.toHaveBeenCalled();
      expect(sibling.retainedWorkCount).toBe(0);
      expect(instance.retainedWorkCount).toBeGreaterThan(0);
      await request.onUtterance({ text: "Speech after the agent turn finished" });
      disabled = prepareDisable(stateDir);
      await expect(disabled.drain()).rejects.toThrow("Transcript capture policy drainage failed");
      expect(disposed).not.toHaveBeenCalled();
      expect(instance.retainedWorkCount).toBeGreaterThan(0);
      state.failing = false;
      await disabled.drain();
      expect(stop).toHaveBeenCalledTimes(2);
      expect(disposed).toHaveBeenCalledOnce();
      expect(instance.retainedWorkCount).toBe(0);
      expect(await store.readSummary(request.session)).toMatchObject({
        summary: { transcript: ["Speech after the agent turn finished"] },
      });
      expect((await store.readSession("retained-capture"))?.stoppedAt).toEqual(expect.any(String));
    } finally {
      state.failing = false;
      agent.release();
      disabled ??= prepareDisable(stateDir);
      await disabled.drain();
      disabled.resume();
      await releaseRegistry();
    }
  },
);
