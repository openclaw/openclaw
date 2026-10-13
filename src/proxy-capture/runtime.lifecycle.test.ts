import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliRecoveryEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DebugProxySettings } from "./env.js";
import { proxyCaptureNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import {
  captureWsEventAsync,
  finalizeDebugProxyCaptureAsync,
  captureHttpExchangeAsync,
} from "./runtime.js";
import {
  listDebugProxyCaptureSessions,
  readDebugProxyCaptureBlob,
  readDebugProxyCaptureSessionEvents,
} from "./store-readonly.js";
import { acquireDebugProxyCaptureStoreAsync } from "./store.async.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetSecretRedactionRegistryForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function stateRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-lifecycle-"));
  roots.push(root);
  return root;
}

function captureSettings(root: string, sessionId = "lifecycle"): DebugProxySettings {
  return {
    enabled: true,
    required: false,
    dbPath: path.join(root, "capture.sqlite"),
    blobDir: path.join(root, "blobs"),
    certDir: path.join(root, "certs"),
    sessionId,
    sourceProcess: "fixture",
  };
}

function runRuntimeScript(
  root: string,
  script: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
) {
  const runtimeUrl = resolveRuntimeWorkerUrl(proxyCaptureNativeProcessEntrypoints.runtime);
  return spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      ...args,
      ...resolveRuntimeWorkerArgv(runtimeUrl).slice(0, -1),
      "--input-type=module",
      "-e",
      script,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_STATE_DIR: root, ...env },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
}

function observePendingCapture(response: Response, prefixChunks: number) {
  const pending = createDeferredCore();
  const settled = createDeferredCore();
  const clone = response.clone.bind(response);
  vi.spyOn(response, "clone").mockImplementation(() => {
    const captured = clone();
    const reader = captured.body!.getReader();
    const read = reader.read.bind(reader);
    let reads = 0;
    vi.spyOn(reader, "read").mockImplementation(() => {
      reads += 1;
      const last = reads === prefixChunks + 1;
      if (last) {
        pending.resolve();
      }
      return read().finally(() => {
        if (last) {
          settled.resolve();
        }
      });
    });
    vi.spyOn(captured.body!, "getReader").mockReturnValue(reader);
    return captured;
  });
  return { pending: pending.promise, settled: settled.promise };
}

function pendingResponse(chunks: Buffer[]) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
      },
    }),
    { status: 200, headers: { "content-type": "text/plain" } },
  );
  return { response, controller: controller!, ...observePendingCapture(response, chunks.length) };
}

describe("async capture lifecycle", () => {
  it.skipIf(process.platform === "win32").each([["SIGTERM", 143]] as const)(
    "drains a queued capture and ends its session on OS %s",
    (signal, exitCode) => {
      const root = stateRoot();
      const settings = captureSettings(root, `signal-${signal}`);
      const payload = `queued capture before ${signal}`;
      const runtimeUrl = resolveRuntimeWorkerUrl(proxyCaptureNativeProcessEntrypoints.runtime);
      const signalUrl = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.signalExitBarrier);
      const script = `
      import { initializeDebugProxyCaptureAsync, captureWsEventAsync } from ${JSON.stringify(runtimeUrl.href)};
      import { installCliSignalExitHandlers } from ${JSON.stringify(signalUrl.href)};
      installCliSignalExitHandlers();
      const settings = ${JSON.stringify(settings)};
      await initializeDebugProxyCaptureAsync("signal-fixture", settings);
      void captureWsEventAsync({
        url: "wss://example.test/signal",
        direction: "outbound",
        kind: "ws-frame",
        flowId: "queued-at-signal",
        payload: ${JSON.stringify(payload)},
      }, settings);
      process.kill(process.pid, ${JSON.stringify(signal)});
    `;
      const child = runRuntimeScript(root, script, [], { HOME: root, XDG_CACHE_HOME: root });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.signal, child.stderr).toBeNull();
      expect(child.status, child.stderr).toBe(exitCode);
      const persisted = withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => {
          const events = readDebugProxyCaptureSessionEvents(db, settings.sessionId);
          const blobId = events[0]?.dataBlobId;
          return {
            session: listDebugProxyCaptureSessions(db).find((row) => row.id === settings.sessionId),
            events,
            payload: typeof blobId === "string" ? readDebugProxyCaptureBlob(db, blobId) : undefined,
          };
        },
        { env: { OPENCLAW_STATE_DIR: root } },
      );
      expect(persisted?.session?.endedAt).toBeTypeOf("number");
      expect(persisted?.events).toEqual([
        expect.objectContaining({
          kind: "ws-frame",
          flowId: "queued-at-signal",
          dataText: payload,
        }),
      ]);
      expect(persisted?.payload).toBe(payload);
    },
  );

  it("prepares immutable HTTP and WebSocket facts and finalizes a redacted prefix while the caller stays open", async () => {
    const root = stateRoot();
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const settings = captureSettings(root, "async-lifecycle");
    registerSecretValueForRedaction("fixture-secret-value");
    const wsBytes = Buffer.from("websocket original");
    const wsMeta = { provider: "fixture", detail: { phase: "accepted" } };
    const wsWriting = captureWsEventAsync(
      {
        url: "wss://example.test/socket",
        direction: "outbound",
        kind: "ws-frame",
        flowId: "ws-before-admission",
        payload: wsBytes,
        meta: wsMeta,
      },
      settings,
    );
    wsBytes.fill(0);
    wsMeta.detail.phase = "mutated";
    const bytes = Buffer.from("first fixture-secret-value café");
    const chunks = [bytes.subarray(0, 15), bytes.subarray(15, -1), bytes.subarray(-1)];
    const stream = pendingResponse(chunks);
    let caller: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let sourceClosed = false;
    try {
      const request = Buffer.from("request original");
      const meta = { detail: { phase: "accepted" } };
      const writing = captureHttpExchangeAsync(
        {
          url: "https://example.test/pending",
          method: "POST",
          requestBody: request,
          response: stream.response,
          flowId: "http-prefix",
          meta,
        },
        settings,
      );
      request.fill(0);
      meta.detail.phase = "mutated";
      // Taking the caller reader immediately would break any clone delayed until after admission.
      caller = stream.response.body!.getReader();
      for (const chunk of chunks) {
        expect(await caller.read()).toEqual({ done: false, value: chunk });
      }
      await stream.pending;
      await finalizeDebugProxyCaptureAsync(settings);
      await Promise.all([writing, wsWriting]);

      // Finalization must settle with the source and caller tee branch still open.
      stream.controller.enqueue(Buffer.from("-later"));
      stream.controller.close();
      sourceClosed = true;
      expect(await caller.read()).toEqual({ done: false, value: Buffer.from("-later") });
      expect(await caller.read()).toEqual({ done: true, value: undefined });
      await stream.settled;

      const reader = await acquireDebugProxyCaptureStoreAsync({
        env: { OPENCLAW_STATE_DIR: root },
      });
      try {
        const rows = (await reader.store.getSessionEvents(settings.sessionId)).toReversed();
        expect(rows).toHaveLength(3);
        expect(rows.map((row) => row.kind)).toEqual(["ws-frame", "request", "response"]);
        expect(rows[0]).toMatchObject({ dataText: "websocket original" });
        expect(JSON.parse(String(rows[0]!.metaJson))).toEqual({
          provider: "fixture",
          detail: { phase: "accepted" },
        });
        expect(rows[1]).toMatchObject({ dataText: "request original" });
        expect(rows[2]).toMatchObject({
          flowId: "http-prefix",
          dataText: "first [REDACTED] café",
          status: 200,
        });
        expect(JSON.parse(String(rows[2]!.metaJson))).toEqual({
          detail: { phase: "accepted" },
          bodyCapture: "finalized",
        });
        expect(await reader.store.readBlob(String(rows[2]!.dataBlobId))).toBe(
          "first [REDACTED] café",
        );
        expect((await reader.store.listSessions())[0]?.endedAt).toBeTypeOf("number");
      } finally {
        await reader.release();
      }
    } finally {
      if (!sourceClosed) {
        stream.controller.close();
      }
      await finalizeDebugProxyCaptureAsync(settings);
      if (caller) {
        await caller.cancel();
      } else {
        await stream.response.body?.cancel();
      }
      await closeOpenClawStateDatabaseByPathAsync(path.join(root, "state", "openclaw.sqlite"));
    }
  });
});
