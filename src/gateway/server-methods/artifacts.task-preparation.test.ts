import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runTaskRegistryWorkerMutation } from "../../tasks/task-registry-state.js";
import {
  configureTaskRegistryRuntime,
  type TaskRegistryStore,
  type TaskRegistryStoreSnapshot,
} from "../../tasks/task-registry.store.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { createInMemoryTaskRegistryStore } from "../../test-utils/task-registry-store.js";
import { artifactsHandlers } from "./artifacts.js";
import { expectErrorDetails, expectFirstArtifact } from "./artifacts.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadSession: vi.fn(),
  visit: vi.fn(),
  resolveRun: vi.fn(),
  managed: vi.fn(),
  allowed: true,
}));
vi.mock("../session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: mocks.loadSession }));
vi.mock("../session-transcript-readers.js", () => ({ visitSessionMessagesAsync: mocks.visit }));
vi.mock("../server-session-key.js", () => ({ resolveSessionKeyForRun: mocks.resolveRun }));
vi.mock("../session-sharing.js", () => ({
  resolveSessionSharingTarget: () => ({ storeKey: "fixture", entry: {} }),
  authorizeIncognitoSessionTarget: () => undefined,
  createSessionListEntryFilter: () => () => mocks.allowed,
}));
vi.mock("../managed-image-attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../managed-image-attachments.js")>()),
  resolveManagedOutgoingMediaArtifactDownload: mocks.managed,
}));

const managedId = "artifact_managed_image_11111111-1111-4111-8111-111111111111";
const methods = ["artifacts.list", "artifacts.get", "artifacts.download"] as const;
function config(owner = "main"): OpenClawConfig {
  return {
    session: { store: "/fixture/sessions.sqlite", scope: "global" },
    agents: {
      ownership: "explicit",
      list: [{ id: "main" }, { id: "ops" }, { id: "worker" }],
      defaults: { sessionStore: { agentId: owner } },
    },
  };
}
function taskStore() {
  let task: TaskRecord = {
    taskId: "task-1",
    runtime: "cli",
    requesterSessionKey: "agent:main:before",
    ownerKey: "agent:main:before",
    agentId: "worker",
    scopeKind: "session",
    task: "artifact preparation",
    status: "succeeded",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 1,
    endedAt: 2,
  };
  const snapshot = (): TaskRegistryStoreSnapshot => ({
    tasks: new Map([[task.taskId, { ...task }]]),
    deliveryStates: new Map(),
  });
  const store: TaskRegistryStore = {
    ...createInMemoryTaskRegistryStore(),
    async withSnapshotAsync(_context, consume) {
      return consume({ snapshot: snapshot(), settledTasks: [], flowSyncs: [] });
    },
    loadSnapshot() {
      throw new Error("artifact lookup attempted a synchronous task read");
    },
    async loadMutationSnapshotAsync() {
      return snapshot();
    },
  };
  configureTaskRegistryRuntime({ store });
  return {
    store,
    snapshot,
    replace: (patch: Partial<TaskRecord>) => (task = { ...task, ...patch }),
  };
}
function request(
  method: (typeof methods)[number],
  query: Record<string, unknown>,
  getRuntimeConfig: () => OpenClawConfig = () => config(),
) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const options: GatewayRequestHandlerOptions = {
    req: { type: "req", id: method, method },
    params: { ...(method === "artifacts.list" ? {} : { artifactId: managedId }), ...query },
    client: null,
    context: { getRuntimeConfig } as never,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => calls.push({ ok, payload, error }),
  };
  return { calls, options, run: () => Promise.resolve(artifactsHandlers[method]!(options)) };
}
function delayRestore(fixture: ReturnType<typeof taskStore>) {
  const started = createDeferred<OpenClawStateWorkerContext>();
  const release = createDeferred();
  fixture.store.withSnapshotAsync = async (context, consume) => {
    started.resolve(context);
    await release.promise;
    return consume({ snapshot: fixture.snapshot(), settledTasks: [], flowSyncs: [] });
  };
  return { started, release };
}
function observe(pending: Promise<void>) {
  return pending.then(
    () => ({ ok: true }),
    (error: unknown) => ({ error }),
  );
}

beforeEach(() => {
  resetTaskRegistryForTests({ persist: false });
  vi.clearAllMocks();
  mocks.allowed = true;
  mocks.loadSession.mockReturnValue({
    storePath: "/fixture/sessions.sqlite",
    entry: { sessionId: "s1" },
  });
  mocks.resolveRun.mockReturnValue("agent:main:run");
  mocks.visit.mockImplementation(async (_scope, visit) => {
    visit(
      {
        role: "assistant",
        content: [{ type: "image", artifactId: managedId, alt: "prepared.png" }],
        __openclaw: { seq: 2, messageTaskId: "task-1", runId: "run-1" },
      },
      2,
    );
    return 1;
  });
  mocks.managed.mockImplementation(async ({ sessionKey }) => ({
    artifactId: managedId,
    sessionKey,
    type: "image",
    title: "prepared.png",
    url: "https://example.test/prepared",
    expiresAt: 100,
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
});

describe("artifact task preparation", () => {
  it.each(methods)(
    "%s selects current task and configuration after preparation",
    async (method) => {
      const fixture = taskStore();
      const gate = delayRestore(fixture);
      let cfg = config();
      const rpc = request(method, { taskId: "task-1", agentId: "worker" }, () => cfg);
      const pending = rpc.run();
      const outcome = observe(pending);
      await Promise.race([gate.started.promise, pending]);
      try {
        expect(mocks.loadSession).not.toHaveBeenCalled();
        expect(rpc.calls).toEqual([]);
        fixture.replace({ requesterSessionKey: "global", ownerKey: "global" });
        cfg = config("ops");
        gate.release.resolve();
        expect(await outcome).toEqual({ ok: true });
        expect(mocks.loadSession).toHaveBeenCalledWith("global", { agentId: "ops" });
        expect(rpc.calls[0]).toMatchObject({ ok: true });
        expect(rpc.calls[0]?.payload).toMatchObject(
          method === "artifacts.list"
            ? { artifacts: [{ sessionKey: "global", title: "prepared.png" }] }
            : { artifact: { sessionKey: "global", title: "prepared.png" } },
        );
      } finally {
        gate.release.resolve();
        await outcome;
      }
    },
  );

  it.each(["store", "admission"] as const)(
    "rejects a retired %s before session lookup",
    async (retired) => {
      const fixture = taskStore();
      const gate = delayRestore(fixture);
      const rpc = request("artifacts.list", { taskId: "task-1" });
      const pending = rpc.run();
      const outcome = observe(pending);
      const context = await Promise.race([gate.started.promise, pending.then(() => undefined)]);
      try {
        expect(context).toBeDefined();
        if (retired === "store") {
          configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
        } else {
          vi.spyOn(context!.admission, "assertCurrent").mockImplementation(() => {
            throw new Error("retired artifact admission");
          });
        }
        gate.release.resolve();
        expect(await outcome).toMatchObject({
          error: expect.objectContaining({
            message: expect.stringContaining(
              retired === "store" ? "no longer current" : "retired artifact admission",
            ),
          }),
        });
        expect(mocks.loadSession).not.toHaveBeenCalled();
        expect(rpc.calls).toEqual([]);
      } finally {
        gate.release.resolve();
        await outcome;
      }
    },
  );

  it("rejects owner replacement during current config capture", async () => {
    taskStore();
    const rpc = request("artifacts.list", { taskId: "task-1" }, () => {
      configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
      return config();
    });
    await expect(rpc.run()).rejects.toThrow("no longer current");
    expect(mocks.loadSession).not.toHaveBeenCalled();
  });

  it.each(["signal", "client authority", "host lifetime"] as const)(
    "stops after %s retires during preparation",
    async (retired) => {
      const fixture = taskStore();
      const gate = delayRestore(fixture);
      const controller = new AbortController();
      let current = true;
      const rpc = request("artifacts.list", { taskId: "task-1" });
      if (retired === "signal") {
        rpc.options.signal = controller.signal;
      }
      if (retired === "client authority") {
        rpc.options.hasCurrentClientAuthority = () => current;
      }
      if (retired === "host lifetime") {
        rpc.options.context.requestEntryLifetime = { signal: controller.signal, enter: vi.fn() };
      }
      const pending = rpc.run();
      const outcome = observe(pending);
      await Promise.race([gate.started.promise, pending]);
      try {
        current = false;
        controller.abort();
        gate.release.resolve();
        expect(await outcome).toEqual({ ok: true });
        expect(mocks.loadSession).not.toHaveBeenCalled();
        expect(rpc.calls).toEqual([]);
      } finally {
        gate.release.resolve();
        await outcome;
      }
    },
  );

  it.each([{ sessionKey: "agent:main:direct" }, { runId: "run-1" }])(
    "bypasses task preparation for stronger selector %j",
    async (selector) => {
      const fixture = taskStore();
      fixture.store.withSnapshotAsync = async () => {
        throw new Error("unused task preparation");
      };
      const rpc = request("artifacts.list", { ...selector, taskId: "task-1" });
      await rpc.run();
      expect(expectFirstArtifact(rpc.calls)).toMatchObject({
        taskId: "task-1",
        title: "prepared.png",
      });
    },
  );

  it.each(["current config", "changed task", "access denied"] as const)(
    "reprepares managed download after transcript await: %s",
    async (change) => {
      const fixture = taskStore();
      fixture.replace({
        requesterSessionKey: "global",
        ownerKey: "global",
        requesterAgentId: "main",
      });
      const transcriptStarted = createDeferred();
      const transcriptRelease = createDeferred();
      const visit = mocks.visit.getMockImplementation()!;
      mocks.visit.mockImplementation(async (...args) => {
        transcriptStarted.resolve();
        await transcriptRelease.promise;
        return visit(...args);
      });
      let cfg = config();
      const rpc = request("artifacts.download", { taskId: "task-1" }, () => cfg);
      const pending = rpc.run();
      const outcome = observe(pending);
      await Promise.race([transcriptStarted.promise, pending]);
      const mutationRelease = createDeferred();
      const context = captureOpenClawStateWorkerContext();
      const refreshed = createDeferred();
      const refreshRelease = createDeferred();
      fixture.store.loadMutationSnapshotAsync = async () => {
        refreshed.resolve();
        await refreshRelease.promise;
        return fixture.snapshot();
      };
      const mutation = runTaskRegistryWorkerMutation(
        { admission: context.admission, scope: { taskId: "task-1", flowId: "artifact-fixture" } },
        () => mutationRelease.promise,
        () => fixture.store.loadMutationSnapshotAsync(context),
      );
      try {
        transcriptRelease.resolve();
        await Promise.race([refreshed.promise, pending]);
        expect(mocks.managed).not.toHaveBeenCalled();
        cfg = config("ops");
        if (change === "changed task") {
          fixture.replace({
            requesterSessionKey: "agent:main:other",
            ownerKey: "agent:main:other",
          });
        }
        if (change === "access denied") {
          mocks.allowed = false;
        }
        refreshRelease.resolve();
        expect(await outcome).toEqual({ ok: true });
        if (change === "current config") {
          expect(mocks.managed).toHaveBeenCalledWith({
            sessionKey: "global",
            agentId: "main",
            defaultAgentId: "ops",
            artifactId: managedId,
          });
          expect(rpc.calls[0]).toMatchObject({
            ok: true,
            payload: { url: "https://example.test/prepared" },
          });
        } else {
          expect(mocks.managed).not.toHaveBeenCalled();
          expect(expectErrorDetails(rpc.calls)).toMatchObject({
            type: change === "changed task" ? "artifact_not_found" : "artifact_scope_not_found",
          });
        }
      } finally {
        transcriptRelease.resolve();
        refreshRelease.resolve();
        mutationRelease.resolve();
        await Promise.all([outcome, mutation]);
      }
    },
  );
});
