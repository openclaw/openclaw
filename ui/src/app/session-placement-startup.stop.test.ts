import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { requestCloudWorkerStop } from "../components/cloud-worker-stop.runtime.ts";
import {
  pauseSessionPlacementRecovery,
  readSessionPlacementRecovery,
  type SessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import * as toast from "../lib/toast.ts";
import { reviewPrivateComposerDraft } from "../pages/chat/components/private-composer-recovery-dialog.ts";
import { PendingSessionPlacementRecoveryState } from "../pages/new-session/session-placement-recovery-state.ts";
import { createChatAttachmentHandoff } from "./chat-attachment-handoff.ts";
import { canReloadControlUiDocument } from "./document-reload-guard.ts";
import createRuntime from "./session-placement-startup.runtime.ts";
import {
  blockStorageWrites,
  createPlacementStartupHarness,
  createStartupPlacement,
  flushStartupMicrotasks,
} from "./session-placement-startup.test-support.ts";
import {
  createApplicationPlacementStartup,
  type ApplicationPlacementStartup,
} from "./session-placement-startup.ts";
import * as chunkRecovery from "./stale-chunk-reload.ts";

describe("placement startup Stop", () => {
  const recoveryAccess = { readSessionPlacementRecovery, pauseSessionPlacementRecovery };

  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function createStopHarness(phase: string) {
    const moduleLoad = createDeferred<{ default: typeof createRuntime }>();
    const dispatch = createDeferred<{ placement: ReturnType<typeof createStartupPlacement> }>();
    const reclaim = createDeferred<{ ok: true }>();
    let nextDispatch = 0;
    const request = vi.fn((method: string, params: { idempotencyKey?: string }) => {
      if (method === "sessions.describe") {
        return Promise.resolve({
          session: { placement: createStartupPlacement("reclaimed", 2) },
        });
      }
      if (method === "sessions.dispatch") {
        return nextDispatch++ === 0
          ? dispatch.promise
          : Promise.resolve({ placement: createStartupPlacement("active", 2) });
      }
      if (method === "sessions.reclaim") {
        return reclaim.promise;
      }
      if (method === "sessions.send") {
        return Promise.resolve({ status: "started", runId: params.idempotencyKey });
      }
      throw new Error(`Unexpected ${method}`);
    });
    const { startup, input, client, gateway, dependencies } = createPlacementStartupHarness(
      request,
      {
        loadRuntime: () => moduleLoad.promise,
        recoveryBeforeStartup: phase === "lazy-recovery",
      },
    );
    const stopClient = gateway.snapshot.client;
    if (!stopClient) {
      throw new Error("Expected the startup fixture client");
    }
    expect(stopClient).toBe(client);
    return {
      startup,
      input,
      client,
      stopClient,
      gateway,
      dependencies,
      request,
      moduleLoad,
      dispatch,
      reclaim,
    };
  }

  function reconnectGateway(
    gateway: ReturnType<typeof createPlacementStartupHarness>["gateway"],
    client: ReturnType<typeof createPlacementStartupHarness>["client"],
  ) {
    for (const phase of ["reconnecting", "connected"] as const) {
      client.recoveryScopeReady = phase === "connected";
      Object.assign(gateway.snapshot, { phase });
      for (const [listener] of vi.mocked(gateway.subscribe).mock.calls) {
        listener(gateway.snapshot);
      }
    }
  }

  describe("cloud Stop owns the held initial turn", () => {
    it.each([
      { phase: "dispatching", storageFails: false },
      { phase: "lazy-recovery", storageFails: false },
      { phase: "dispatching", storageFails: true },
      { phase: "lazy-start", storageFails: true },
    ] as const)(
      "pauses $phase (storage failure: $storageFails) before reclaim and rejects late active dispatch until explicit Retry",
      async ({ phase, storageFails }) => {
        const {
          startup,
          input,
          client,
          stopClient,
          gateway,
          dependencies,
          request,
          moduleLoad,
          dispatch,
          reclaim,
        } = createStopHarness(phase);
        let activeStartup = startup;
        try {
          if (phase === "lazy-recovery") {
            startup.resumeRecovery();
          } else {
            startup.start(input);
          }
          if (phase === "dispatching") {
            moduleLoad.resolve({ default: createRuntime });
            await vi.waitFor(() =>
              expect(request).toHaveBeenCalledWith("sessions.dispatch", expect.anything()),
            );
          }
          if (storageFails) {
            blockStorageWrites();
          }
          const stopped = requestCloudWorkerStop(
            stopClient,
            { key: input.recovery.sessionKey },
            startup,
          );
          expect(request).toHaveBeenCalledWith("sessions.reclaim", expect.anything(), {
            timeoutMs: null,
          });
          moduleLoad.resolve({ default: createRuntime });
          dispatch.resolve({ placement: createStartupPlacement("active", 1) });
          await flushStartupMicrotasks();
          await flushStartupMicrotasks();
          expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(
            0,
          );
          const saved = readSessionPlacementRecovery(
            input.recovery.gatewayUrl,
            input.recovery.recoveryScope,
            input.recovery.sessionKey,
          );
          if (!storageFails) {
            expect(saved).toMatchObject({
              phase: "paused",
              reason: "not-sent",
              messageId: input.recovery.messageId,
            });
          } else {
            expect(saved).toBeNull();
          }
          reclaim.resolve({ ok: true });
          await stopped;
          reconnectGateway(gateway, client);
          await flushStartupMicrotasks();
          expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(
            0,
          );
          expect(startup.get(input.recovery.sessionKey)).toMatchObject({
            phase: "failed",
            action: "retry",
            initialTurn: { text: input.recovery.message, sendRunId: input.recovery.messageId },
          });
          expect(
            request.mock.calls.filter(([method]) => method === "sessions.reclaim"),
          ).toHaveLength(1);
          vi.unstubAllGlobals();
          if (!storageFails) {
            startup.dispose();
            activeStartup = createApplicationPlacementStartup(dependencies, async () => ({
              default: createRuntime,
            }));
            activeStartup.resumeRecovery();
            await vi.waitFor(() =>
              expect(activeStartup.get(input.recovery.sessionKey)?.action).toBe("retry"),
            );
            expect(
              request.mock.calls.filter(([method]) => method === "sessions.send"),
            ).toHaveLength(0);
          }
          activeStartup.retry(input.recovery.sessionKey);
          await vi.waitFor(() =>
            expect(
              request.mock.calls.filter(([method]) => method === "sessions.send"),
            ).toHaveLength(1),
          );
        } finally {
          reclaim.resolve({ ok: true });
          activeStartup.dispose();
        }
      },
    );
    it("pauses only the stopped session while another initial turn completes", async () => {
      const dispatch = createDeferred<{ placement: ReturnType<typeof createStartupPlacement> }>();
      const request = vi.fn((method: string, params: { idempotencyKey?: string }) =>
        method === "sessions.dispatch"
          ? dispatch.promise
          : Promise.resolve({ status: "started", runId: params.idempotencyKey }),
      );
      const { startup, input, client, gateway } = createPlacementStartupHarness(request);
      const stopClient = gateway.snapshot.client;
      if (!stopClient) {
        throw new Error("Expected the startup fixture client");
      }
      expect(stopClient).toBe(client);
      try {
        startup.start(input);
        startup.start({
          ...input,
          recovery: {
            ...input.recovery,
            sessionKey: "agent:cloud:other",
            messageId: "other-message",
          },
        });
        await vi.waitFor(() =>
          expect(
            request.mock.calls.filter(([method]) => method === "sessions.dispatch"),
          ).toHaveLength(2),
        );
        await requestCloudWorkerStop(stopClient, { key: input.recovery.sessionKey }, startup);
        dispatch.resolve({ placement: createStartupPlacement("active", 1) });
        await vi.waitFor(() =>
          expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(
            1,
          ),
        );
        expect(request).toHaveBeenCalledWith(
          "sessions.send",
          expect.objectContaining({ key: "agent:cloud:other", idempotencyKey: "other-message" }),
        );
        expect(startup.get(input.recovery.sessionKey)?.action).toBe("retry");
      } finally {
        startup.dispose();
      }
    });

    it.each(["disposed", "credential", "connection"] as const)(
      "does not pause a retired %s owner",
      async (retirement) => {
        const moduleLoad = createDeferred<{ default: typeof createRuntime }>();
        const request = vi.fn();
        const { startup, input, client, gateway } = createPlacementStartupHarness(request, {
          loadRuntime: () => moduleLoad.promise,
        });
        startup.start(input);
        if (retirement === "disposed") {
          startup.dispose();
        } else if (retirement === "credential") {
          client.recoveryScope = "principal-b";
        } else {
          Object.assign(gateway, { connectionRevision: gateway.connectionRevision + 1 });
          Object.assign(gateway.connection, { gatewayUrl: "ws://replacement.example" });
        }
        startup.pause(input.recovery.sessionKey, "stopped", recoveryAccess);
        expect(
          readSessionPlacementRecovery(
            input.recovery.gatewayUrl,
            input.recovery.recoveryScope,
            input.recovery.sessionKey,
          )?.phase,
        ).toBe("dispatching");
        expect(request).not.toHaveBeenCalled();
        startup.dispose();
        moduleLoad.resolve({ default: createRuntime });
        await flushStartupMicrotasks();
      },
    );

    it.each(["credential", "message"] as const)(
      "does not pause a replaced live %s owner",
      async (replacement) => {
        const dispatch = createDeferred<{ placement: ReturnType<typeof createStartupPlacement> }>();
        const request = vi.fn((_method: string) => dispatch.promise);
        const { startup, input, client } = createPlacementStartupHarness(request);
        try {
          startup.start(input);
          await vi.waitFor(() =>
            expect(request).toHaveBeenCalledWith("sessions.dispatch", expect.anything()),
          );
          const replacementRecovery = { ...input.recovery, messageId: "replacement-message" };
          if (replacement === "credential") {
            client.recoveryScope = "principal-b";
          } else {
            expect(writeSessionPlacementRecovery(replacementRecovery)).toBe(true);
          }
          startup.pause(input.recovery.sessionKey, "stopped", recoveryAccess);
          dispatch.resolve({ placement: createStartupPlacement("active", 1) });
          await flushStartupMicrotasks();
          expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(
            0,
          );
          expect(
            readSessionPlacementRecovery(
              input.recovery.gatewayUrl,
              input.recovery.recoveryScope,
              input.recovery.sessionKey,
            ),
          ).toMatchObject({
            phase: "dispatching",
            messageId:
              replacement === "message" ? replacementRecovery.messageId : input.recovery.messageId,
          });
        } finally {
          startup.dispose();
        }
      },
    );
    it("keeps delivery uncertain when Stop follows an in-flight send", async () => {
      const sent = createDeferred<{ status: string; runId: string }>();
      const request = vi.fn((method: string) => {
        if (method === "sessions.dispatch") {
          return Promise.resolve({ placement: createStartupPlacement("active", 1) });
        }
        if (method === "sessions.send") {
          return sent.promise;
        }
        if (method === "chat.history") {
          return Promise.resolve({ messages: [] });
        }
        if (method === "sessions.reclaim") {
          return Promise.resolve({ ok: true });
        }
        throw new Error(`Unexpected ${method}`);
      });
      const { startup, input, client, gateway } = createPlacementStartupHarness(request);
      const stopClient = gateway.snapshot.client;
      if (!stopClient) {
        throw new Error("Expected the startup fixture client");
      }
      expect(stopClient).toBe(client);
      try {
        startup.start(input);
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith("sessions.send", expect.anything()),
        );
        await requestCloudWorkerStop(stopClient, { key: input.recovery.sessionKey }, startup);
        sent.resolve({ status: "started", runId: input.recovery.messageId });
        await flushStartupMicrotasks();
        expect(startup.get(input.recovery.sessionKey)).toMatchObject({
          phase: "failed",
          action: "check-delivery",
          initialTurn: { sendRunId: input.recovery.messageId, sendState: "unconfirmed" },
        });
        startup.retry(input.recovery.sessionKey);
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith("chat.history", expect.anything()),
        );
        await flushStartupMicrotasks();
        for (const method of ["sessions.dispatch", "sessions.send", "sessions.reclaim"]) {
          expect(request.mock.calls.filter(([name]) => name === method)).toHaveLength(1);
        }
        expect(startup.get(input.recovery.sessionKey)?.action).toBe("check-delivery");
      } finally {
        startup.dispose();
      }
    });
  });
});

describe("placement startup Retry", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function restorePausedStartup(request: ReturnType<typeof vi.fn>) {
    const harness = createPlacementStartupHarness(request);
    expect(
      writeSessionPlacementRecovery({
        ...harness.input.recovery,
        phase: "paused",
        reason: "not-sent",
        error: "session placement reconciliation timed out",
      }),
    ).toBe(true);
    harness.startup.resumeRecovery();
    await flushStartupMicrotasks();
    expect(harness.startup.get(harness.input.recovery.sessionKey)?.action).toBe("retry");
    return harness;
  }

  describe("initial turn Retry after slow placement recovery", () => {
    it("retains initial-turn identity until derived content changes in the runtime getter", async () => {
      const dispatch = createDeferred<unknown>();
      const { startup, input } = createPlacementStartupHarness(vi.fn(() => dispatch.promise));
      const recovery: SessionPlacementRecovery = {
        ...input.recovery,
        phase: "paused",
        reason: "not-sent",
        error: "Worker setup failed",
      };
      expect(writeSessionPlacementRecovery(recovery)).toBe(true);
      try {
        startup.start({ ...input, recovery });
        await flushStartupMicrotasks();
        const first = startup.get(recovery.sessionKey)?.initialTurn;
        expect(startup.get(recovery.sessionKey)?.initialTurn).toBe(first);
        expect(first).toMatchObject({ sendState: "failed", sendError: recovery.error });

        recovery.error = "Worker setup failed again";
        const changed = startup.get(recovery.sessionKey)?.initialTurn;
        expect(changed).not.toBe(first);
        expect(changed).toMatchObject({ sendState: "failed", sendError: recovery.error });
        expect(startup.get(recovery.sessionKey)?.initialTurn).toBe(changed);

        startup.pause(recovery.sessionKey, "Worker stopped", {
          readSessionPlacementRecovery,
          pauseSessionPlacementRecovery,
        });
        const paused = startup.get(recovery.sessionKey)?.initialTurn;
        expect(paused).not.toBe(changed);
        expect(paused).toMatchObject({ sendState: "failed", sendError: "Worker stopped" });
        expect(startup.get(recovery.sessionKey)?.initialTurn).toBe(paused);

        startup.retry(recovery.sessionKey);
        const retried = startup.get(recovery.sessionKey)?.initialTurn;
        expect(retried).not.toBe(paused);
        expect(retried?.sendState).toBe("sending");
        expect(retried).not.toHaveProperty("sendError");
        expect(startup.get(recovery.sessionKey)?.initialTurn).toBe(retried);
      } finally {
        startup.dispose();
        dispatch.resolve({ placement: createStartupPlacement("active", 2) });
        await flushStartupMicrotasks();
      }
    });

    it("reuses a worker that becomes active after recovery times out and sends only once", async () => {
      vi.useFakeTimers();
      let placement = createStartupPlacement("provisioning", 1);
      const request = vi.fn(async (method: string, params?: { idempotencyKey?: string }) => {
        if (method === "sessions.describe") {
          return { session: { sessionId: "session-startup", placement } };
        }
        if (method === "sessions.dispatch") {
          // The Gateway rejects redispatch once an existing placement is active.
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: `session cannot dispatch from placement ${placement.state}`,
          });
        }
        if (method === "sessions.send") {
          return { status: "started", runId: params?.idempotencyKey };
        }
        throw new Error(`Unexpected ${method}`);
      });
      const { startup, input, chatSubmissions, client } = createPlacementStartupHarness(request, {
        recoveryBeforeStartup: true,
      });
      const { sessionKey, gatewayUrl, recoveryScope, messageId } = input.recovery;
      try {
        startup.resumeRecovery();
        await vi.runAllTimersAsync();
        expect(startup.get(sessionKey)).toMatchObject({
          phase: "failed",
          action: "retry",
          error:
            "Worker setup is still in progress. Retry to check the existing worker; your message has not been sent.",
          initialTurn: { text: input.recovery.message, sendRunId: messageId },
        });
        expect(readSessionPlacementRecovery(gatewayUrl, recoveryScope, sessionKey)).toMatchObject({
          phase: "paused",
          reason: "not-sent",
          messageId,
        });
        expect(request.mock.calls.some(([method]) => method === "sessions.reclaim")).toBe(false);

        placement = createStartupPlacement("active", 2);
        startup.retry(sessionKey);
        startup.retry(sessionKey);
        await vi.runAllTimersAsync();

        expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toEqual([
          [
            "sessions.send",
            expect.objectContaining({
              key: sessionKey,
              message: input.recovery.message,
              idempotencyKey: messageId,
            }),
          ],
        ]);
        expect(request.mock.calls.some(([method]) => method === "sessions.dispatch")).toBe(false);
        expect(startup.get(sessionKey)).toBeNull();
        expect(readSessionPlacementRecovery(gatewayUrl, recoveryScope, sessionKey)).toBeNull();
        expect(chatSubmissions.readInitial(sessionKey, client)).not.toBeNull();
      } finally {
        startup.dispose();
      }
    });

    it.each([
      { state: "missing", released: true },
      { state: "failed", released: true },
      { state: "failed", released: false },
    ])(
      "redispatches $state only with Gateway admission (released: $released)",
      async ({ state, released }) => {
        const request = vi.fn(async (method: string) => {
          if (method === "sessions.describe") {
            return {
              session: state === "missing" ? null : { placement: createStartupPlacement(state, 1) },
            };
          }
          if (state === "missing") {
            throw new Error(`Unexpected ${method}`);
          }
          if (method === "sessions.dispatch") {
            if (!released) {
              throw new GatewayRequestError({
                code: "INVALID_REQUEST",
                message:
                  "cloud worker environment must be stopped before redispatch; use Stop cloud worker",
              });
            }
            return { placement: createStartupPlacement("active", 2) };
          }
          if (method === "sessions.send") {
            return { status: "started" };
          }
          throw new Error(`Unexpected ${method}`);
        });
        const { startup, input } = await restorePausedStartup(request);
        try {
          startup.retry(input.recovery.sessionKey);
          startup.retry(input.recovery.sessionKey);
          await vi.waitFor(() => {
            if (released) {
              expect(startup.get(input.recovery.sessionKey)).toBeNull();
            } else {
              expect(startup.get(input.recovery.sessionKey)).toMatchObject({
                phase: "failed",
                error:
                  "cloud worker environment must be stopped before redispatch; use Stop cloud worker",
              });
            }
          });
          expect(request.mock.calls.map(([method]) => method)).toEqual([
            "sessions.describe",
            ...(state === "missing"
              ? []
              : ["sessions.dispatch", ...(released ? ["sessions.send"] : [])]),
          ]);
          if (state === "missing") {
            expect(sessionStorage.length).toBe(0);
          }
        } finally {
          startup.dispose();
        }
      },
    );

    it.each([undefined, "failed"])(
      "does not allocate during passive recovery of %s placement",
      async (state) => {
        vi.useFakeTimers();
        const request = vi.fn(async (method: string) => {
          if (method === "sessions.describe") {
            return { session: { placement: state ? createStartupPlacement(state, 1) : undefined } };
          }
          if (method === "sessions.reclaim") {
            return { ok: true };
          }
          throw new Error(`Unexpected ${method}`);
        });
        const { startup, input } = createPlacementStartupHarness(request, {
          recoveryBeforeStartup: true,
        });
        try {
          startup.resumeRecovery();
          await vi.runAllTimersAsync();
          expect(startup.get(input.recovery.sessionKey)?.action).toBe("retry");
          expect(
            request.mock.calls.every(
              ([method]) => method === "sessions.describe" || method === "sessions.reclaim",
            ),
          ).toBe(true);
        } finally {
          startup.dispose();
        }
      },
    );

    it("Stop fences a late active read during Retry before any send or dispatch", async () => {
      const description = createDeferred<unknown>();
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.describe") {
          return description.promise;
        }
        if (method === "sessions.reclaim") {
          return { ok: true };
        }
        throw new Error(`Unexpected ${method}`);
      });
      const { startup, input, gateway } = await restorePausedStartup(request);
      const client = gateway.snapshot.client;
      if (!client) {
        throw new Error("Expected the startup fixture client");
      }
      try {
        startup.retry(input.recovery.sessionKey);
        await flushStartupMicrotasks();
        await requestCloudWorkerStop(client, { key: input.recovery.sessionKey }, startup);
        description.resolve({ session: { placement: createStartupPlacement("active", 2) } });
        await flushStartupMicrotasks();
        expect(startup.get(input.recovery.sessionKey)).toMatchObject({
          phase: "failed",
          action: "retry",
          initialTurn: { sendRunId: input.recovery.messageId },
        });
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "sessions.describe",
          "sessions.reclaim",
        ]);
      } finally {
        description.resolve({ session: null });
        startup.dispose();
      }
    });
  });
});

describe("placement startup reload", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reloads a saved paused startup after a cached import failure", async () => {
    const reload = vi
      .spyOn(chunkRecovery, "retryStaleChunkReloadWhenReachable")
      .mockResolvedValue(false);
    const loadRuntime = vi.fn(() =>
      Promise.reject(new Error("Failed to fetch dynamically imported module: /assets/startup.js")),
    );
    const { startup, input } = createPlacementStartupHarness(vi.fn(), { loadRuntime });
    try {
      startup.start(input);
      await flushStartupMicrotasks();
      startup.pause(input.recovery.sessionKey, "Stopped before startup", {
        readSessionPlacementRecovery,
        pauseSessionPlacementRecovery,
      });
      await flushStartupMicrotasks();
      const importsBeforeRetry = loadRuntime.mock.calls.length;
      expect(startup.get(input.recovery.sessionKey)).toMatchObject({
        phase: "failed",
        retryable: true,
      });
      startup.retry(input.recovery.sessionKey);
      expect(reload).toHaveBeenCalledOnce();
      expect(reload.mock.calls[0]?.[0]?.canReload?.()).toBe(true);
      expect(loadRuntime).toHaveBeenCalledTimes(importsBeforeRetry);
    } finally {
      startup.dispose();
    }
  });

  it.each(["Incognito", "failed pause write"])(
    "keeps unsaved input after %s while explaining blocked recovery on both sessions",
    async (cause) => {
      const fetch = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetch);
      const reload = vi.fn();
      const loadRuntime = vi.fn(() =>
        Promise.reject(
          new Error("Failed to fetch dynamically imported module: /assets/startup.js"),
        ),
      );
      const { startup, input, gateway } = createPlacementStartupHarness(vi.fn(), { loadRuntime });
      const privateKey = "agent:cloud:incognito";
      const saved = Object.entries(sessionStorage);
      try {
        startup.resumeRecovery();
        await flushStartupMicrotasks();
        const memoryInput = {
          ...input,
          persistRecovery: cause !== "Incognito",
          recovery: { ...input.recovery, sessionKey: privateKey, message: "private unsent text" },
        };
        if (memoryInput.persistRecovery) {
          expect(writeSessionPlacementRecovery(memoryInput.recovery)).toBe(true);
        }
        startup.start(memoryInput);
        await flushStartupMicrotasks();
        if (cause === "failed pause write") {
          const storage = blockStorageWrites();
          startup.pause(privateKey, "Stopped before startup", {
            readSessionPlacementRecovery,
            pauseSessionPlacementRecovery,
          });
          await flushStartupMicrotasks();
          vi.stubGlobal("sessionStorage", storage);
        }
        for (const key of [input.recovery.sessionKey, privateKey]) {
          expect(startup.hasPendingTurn(key)).toBe(true);
          expect(startup.get(key)).toMatchObject({
            phase: "failed",
            retryable: false,
            error: "Recovery needs a reload. Unsaved starts will be lost.",
          });
        }
        startup.retry(input.recovery.sessionKey);
        expect(
          await chunkRecovery.scheduleStaleChunkReload({
            reload,
            storage: sessionStorage,
            buildId: `unsaved-${cause}`,
          }),
        ).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(Object.entries(sessionStorage)).toEqual(saved);
        expect(startup.hasPendingTurn(privateKey)).toBe(true);

        // Credential replacement retires this input's authority; it cannot block the new owner.
        Object.assign(gateway, { connectionRevision: gateway.connectionRevision + 1 });
        vi.mocked(gateway.subscribe).mock.calls[0]?.[0](gateway.snapshot);
        expect(startup.get(privateKey)).toBeNull();
        expect(startup.get(input.recovery.sessionKey)).toMatchObject({
          phase: "failed",
          retryable: true,
        });
        expect(
          await chunkRecovery.scheduleStaleChunkReload({
            reload,
            storage: sessionStorage,
            buildId: `unsaved-${cause}`,
          }),
        ).toBe(true);
        expect(reload).toHaveBeenCalledOnce();
      } finally {
        startup.dispose();
      }
    },
  );

  it.each(["current", "private draft", "start", "credentials", "scope", "gateway", "dispose"])(
    "binds explicit discard to the captured startup owner: %s",
    async (change) => {
      const reload = vi
        .spyOn(chunkRecovery, "reloadControlUiDocument")
        .mockImplementation(() => {});
      const loadRuntime = vi.fn(() =>
        Promise.reject(
          new Error("Failed to fetch dynamically imported module: /assets/startup.js"),
        ),
      );
      const { startup, input, gateway, client } = createPlacementStartupHarness(vi.fn(), {
        loadRuntime,
      });
      const handoff = createChatAttachmentHandoff(gateway);
      const show = vi.spyOn(toast, "showToast").mockReturnValue(false);
      try {
        startup.start({ ...input, persistRecovery: false });
        await flushStartupMicrotasks();
        const discard = startup.get(input.recovery.sessionKey)?.discardAndReload;
        expect(discard).toBeTypeOf("function");
        if (change === "private draft") {
          handoff.prepare({
            owner: gateway.snapshot.client,
            paneId: "private-pane",
            scopeKey: "private-draft",
            incognito: true,
            message: "Keep this separate private draft",
            attachments: [],
            fallbacks: {},
            reviewPrivateDraft: reviewPrivateComposerDraft,
          });
        } else if (change === "start") {
          startup.start({
            ...input,
            persistRecovery: false,
            recovery: { ...input.recovery, messageId: "newer-input" },
          });
        } else if (change === "credentials") {
          Object.assign(gateway, { connectionRevision: 1 });
        } else if (change === "scope") {
          client.recoveryScope = "replacement-scope";
        } else if (change === "gateway") {
          gateway.connection.gatewayUrl = "ws://replacement.example";
        } else if (change === "dispose") {
          startup.dispose();
        }
        discard?.();
        expect(reload).toHaveBeenCalledTimes(change === "current" ? 1 : 0);
        if (change === "current" || change === "private draft") {
          expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(false);
        }
        if (change === "private draft") {
          expect(show.mock.lastCall?.[0].actionLabel).toBe("Review private draft");
          expect(
            handoff.consume({
              owner: gateway.snapshot.client,
              paneId: "private-pane",
              scopeKey: "private-draft",
            })?.message,
          ).toBe("Keep this separate private draft");
        }
      } finally {
        handoff.dispose();
        startup.dispose();
      }
    },
  );

  it("cannot dispatch a discarded unsaved start when its lazy runtime later settles", async () => {
    const show = vi.spyOn(toast, "showToast").mockReturnValue(false);
    const reload = vi.spyOn(chunkRecovery, "reloadControlUiDocument").mockImplementation(() => {});
    const loading = createDeferred<{ default: typeof createRuntime }>();
    const request = vi.fn();
    const { startup, input } = createPlacementStartupHarness(request, {
      loadRuntime: () => loading.promise,
    });
    sessionStorage.clear();
    try {
      startup.start({ ...input, persistRecovery: false });
      expect(canReloadControlUiDocument(true)).toBe(false);
      const discard = show.mock.lastCall?.[0].onAction;
      expect(discard).toBeTypeOf("function");
      discard?.();
      expect(reload).toHaveBeenCalledOnce();
      expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(false);
      loading.resolve({ default: createRuntime });
      await flushStartupMicrotasks();
      expect(request).not.toHaveBeenCalled();
      expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(false);
    } finally {
      startup.dispose();
    }
  });

  it("rejects a retained toast action when another unsaved start joins the same pending import", async () => {
    const show = vi.spyOn(toast, "showToast").mockReturnValue(false);
    const reload = vi.spyOn(chunkRecovery, "reloadControlUiDocument").mockImplementation(() => {});
    const loading = createDeferred<{ default: () => ApplicationPlacementStartup }>();
    const loadRuntime = vi.fn(() => loading.promise);
    const { startup, input } = createPlacementStartupHarness(vi.fn(), { loadRuntime });
    try {
      startup.start({ ...input, persistRecovery: false });
      expect(await chunkRecovery.retryStaleChunkReloadWhenReachable()).toBe(false);
      const discard = show.mock.calls[0]?.[0].onAction;
      expect(discard).toBeTypeOf("function");
      startup.start({
        ...input,
        persistRecovery: false,
        recovery: { ...input.recovery, sessionKey: "agent:cloud:another-unsaved-start" },
      });
      expect(loadRuntime).toHaveBeenCalledOnce();
      discard?.();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      startup.dispose();
    }
  });

  it.each(["snapshot", "reload"])("releases New Session Reset recovery before %s", async (next) => {
    const reload = vi
      .spyOn(chunkRecovery, "retryStaleChunkReloadWhenReachable")
      .mockResolvedValue(false);
    const loader = vi.fn(() =>
      Promise.reject(new Error("Failed to fetch dynamically imported module: /assets/startup.js")),
    );
    const { startup, input, gateway } = createPlacementStartupHarness(vi.fn(), {
      loadRuntime: loader,
    });
    sessionStorage.clear();
    const pending = new PendingSessionPlacementRecoveryState();
    expect(
      pending.stageCreate({
        ...input.recovery,
        createParams: { agentId: input.recovery.agentId, message: "", worktree: true },
      }),
    ).not.toBeNull();
    const key = pending.sessionKey;
    startup.resumeRecovery();
    await flushStartupMicrotasks();
    expect(startup.hasPendingTurn(key)).toBe(true);
    startup.retry(key);
    const canReload = reload.mock.calls[0]?.[0]?.canReload;
    expect(canReload?.()).toBe(true);

    pending.clear();
    if (next === "snapshot") {
      vi.mocked(gateway.subscribe).mock.calls[0]?.[0](gateway.snapshot);
    }
    expect(canReload?.()).toBe(false);
    expect(sessionStorage.length).toBe(0);
    expect(startup.hasPendingTurn(key)).toBe(false);
    expect(startup.get(key)).toBeNull();
    expect(loader).toHaveBeenCalledOnce();
    startup.dispose();
  });

  it.each(["credentials", "scope", "gateway"])(
    "retires a restored reload owner after its %s changes",
    async (change) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const reload = vi
        .spyOn(chunkRecovery, "retryStaleChunkReloadWhenReachable")
        .mockResolvedValue(false);
      const loader = vi.fn(() =>
        Promise.reject(
          new Error("Failed to fetch dynamically imported module: /assets/startup.js"),
        ),
      );
      const { startup, input, gateway, client } = createPlacementStartupHarness(vi.fn(), {
        loadRuntime: loader,
      });
      startup.resumeRecovery();
      await flushStartupMicrotasks();
      startup.retry(input.recovery.sessionKey);
      const canReload = reload.mock.calls[0]?.[0]?.canReload;
      expect(canReload?.()).toBe(true);

      now.mockReturnValue(2_000);
      if (change === "credentials") {
        Object.assign(gateway, { connectionRevision: 1 });
      }
      if (change === "scope") {
        client.recoveryScope = "principal-b";
      }
      if (change === "gateway") {
        gateway.connection.gatewayUrl = "ws://other.example";
      }
      vi.mocked(gateway.subscribe).mock.calls[0]?.[0](gateway.snapshot);
      expect(canReload?.()).toBe(false);
      expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(change === "credentials");
      if (change === "credentials") {
        expect(startup.get(input.recovery.sessionKey)).toMatchObject({
          phase: "failed",
          startedAt: 2_000,
        });
      } else {
        expect(startup.get(input.recovery.sessionKey)).toBeNull();
        client.recoveryScope = input.recovery.recoveryScope;
        gateway.connection.gatewayUrl = input.recovery.gatewayUrl;
        vi.mocked(gateway.subscribe).mock.calls[0]?.[0](gateway.snapshot);
        expect(startup.hasPendingTurn(input.recovery.sessionKey)).toBe(true);
        expect(canReload?.()).toBe(false);
      }
      await flushStartupMicrotasks();
      expect(loader).toHaveBeenCalledOnce();
      startup.dispose();
    },
  );

  it.each(["disposal", "memory-only"])(
    "does not reload a restored startup after %s custody prevents it",
    async (change) => {
      const reload = vi
        .spyOn(chunkRecovery, "retryStaleChunkReloadWhenReachable")
        .mockResolvedValue(false);
      const loadRuntime = vi.fn(() =>
        Promise.reject(
          new Error("Failed to fetch dynamically imported module: /assets/startup-runtime.js"),
        ),
      );
      const { startup, input } = createPlacementStartupHarness(vi.fn(), { loadRuntime });
      startup.resumeRecovery();
      if (change === "memory-only") {
        startup.start({
          ...input,
          persistRecovery: false,
          recovery: { ...input.recovery, sessionKey: "agent:cloud:incognito" },
        });
      }
      await flushStartupMicrotasks();
      startup.retry(input.recovery.sessionKey);
      expect(reload).toHaveBeenCalledOnce();
      const canReload = reload.mock.calls[0]?.[0]?.canReload;
      expect(canReload?.()).toBe(change !== "memory-only");
      if (change === "disposal") {
        startup.dispose();
      }
      expect(canReload?.()).toBe(false);
      expect(loadRuntime).toHaveBeenCalledOnce();
      startup.dispose();
    },
  );
});
