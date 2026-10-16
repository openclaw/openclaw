import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import { connect, type Socket } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import "../../src/test-utils/prepare-compiled-subprocesses.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { createFixtureLifetime } from "./fixture-lifetime.js";
import { createDeferred } from "./promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "./qa-gateway-cleanup.js";

const fixture = createFixtureLifetime();
const qaModuleId = (artifactBasename: string) =>
  resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId: "qa-lab",
    artifactBasename,
  });
const qaApiModuleId = qaModuleId("api.js");
const qaRuntimeModuleId = qaModuleId("runtime-api.js");
const noop = async () => {};
const reject = (error: Error) => async () => {
  throw error;
};
const mockBus = (stop: () => Promise<void>, port = 1) => ({
  createQaBusState: () => ({}),
  createQaChannelTransport: () => ({}),
  startQaBusServer: async () => ({ baseUrl: `http://127.0.0.1:${port}`, stop }),
});
type FixtureBody = (context: Pick<TestContext, "signal" | "onTestFinished">) => Promise<void>;

function captureTests<T extends (...args: never[]) => Promise<void>>(webchat = false) {
  const bodies: T[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  vi.doMock("vitest", () => ({
    [webchat ? "afterEach" : "afterAll"]: (cleanup: () => Promise<void>) => cleanups.push(cleanup),
    describe: (_name: string, body: () => void) => body(),
    ...(webchat
      ? { it: (_name: string, _options: unknown, body: T) => bodies.push(body) }
      : { test: (_name: string, body: T) => bodies.push(body) }),
    expect,
  }));
  return { bodies, cleanups };
}

function mockEvidence(includeEntries = false) {
  const written: Array<{ status: string; details?: string }> = [];
  vi.doMock("../e2e/qa-lab/runtime/script-evidence.js", () => ({
    createQaScriptEvidenceWriter: () => ({
      appendLog: () => {},
      write: async (result: (typeof written)[number]) => {
        written.push(result);
        return includeEntries ? { entries: [{ result }] } : undefined;
      },
    }),
  }));
  return written;
}

function expectFailure(written: ReturnType<typeof mockEvidence>, ...messages: string[]) {
  expect(written).toMatchObject([{ status: "fail", details: expect.any(String) }]);
  for (const message of messages) {
    expect(written[0]?.details).toContain(message);
  }
}

async function tempRoot(prefix: string) {
  const root = await fs.realpath(fixture.createTempDir(prefix));
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, root);
  }
  return root;
}

afterEach(async () => {
  try {
    // Vitest cancellation rejects its wrapper, not the original body/import.
    // Join those continuations before resetting their mocks and environment.
    await fixture.cleanup();
  } finally {
    vi.doUnmock("vitest");
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("node:child_process");
    vi.doUnmock(qaApiModuleId);
    vi.doUnmock(qaRuntimeModuleId);
    vi.doUnmock("../../src/gateway/client.js");
    vi.doUnmock("../../scripts/e2e/lib/plugin-index-sqlite.mjs");
    vi.doUnmock("../e2e/qa-lab/runtime/otel-test-support.js");
    vi.doUnmock("../e2e/qa-lab/runtime/script-evidence.js");
    vi.doUnmock("../e2e/qa-lab/runtime/paired-node-worker-wire-fixture.js");
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});

function errorTree(error: unknown): unknown[] {
  return error instanceof AggregateError ? [error, ...error.errors.flatMap(errorTree)] : [error];
}

function cleanupStep(events: string[], label: string, error?: Error) {
  return async () => {
    events.push(label);
    if (error) {
      throw error;
    }
  };
}

const cleanupResult =
  <T>(events: string[], result: T) =>
  async () => {
    events.push("gateway");
    return result;
  };

describe("QA gateway fixture error composition", () => {
  it.for(["joined", "unconfirmed", "rejected"] as const)(
    "keeps the generation workspace through a held server close and %s Gateway cleanup",
    (shutdown, { signal }) =>
      fixture.run(async () => {
        const root = await tempRoot("qa-generation-cleanup-");
        const cleanupStarted = createDeferred();
        const cleaned: string[] = [];
        const written = mockEvidence(true);
        let workspaceRoot = "";
        let socket: Socket | undefined;
        let peer: Duplex | undefined;
        let serverJoined = false;
        let removal: Promise<void> | undefined;
        const remove = fs.rm.bind(fs);
        vi.spyOn(fs, "rm").mockImplementation((target, options) => {
          const operation = remove(target, options);
          if (target === workspaceRoot) {
            removal = operation;
          }
          return operation;
        });
        vi.doMock(
          "../e2e/qa-lab/runtime/paired-node-worker-wire-fixture.js",
          async (importOriginal) => {
            const actual =
              await importOriginal<
                typeof import("../e2e/qa-lab/runtime/paired-node-worker-wire-fixture.js")
              >();
            return {
              ...actual,
              createPublishedWireWorkspace: async (ownedRoot: string) => {
                workspaceRoot = ownedRoot;
                const published = await actual.createPublishedWireWorkspace(ownedRoot);
                const address = published.server.address();
                if (!address || typeof address === "string") {
                  throw new Error("workspace server did not bind");
                }
                published.server.once("close", () => {
                  serverJoined = true;
                });
                published.server.once("upgrade", (_request, upgraded) => {
                  peer = upgraded;
                  upgraded.write(
                    "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n",
                  );
                });
                if (signal.aborted) {
                  return published;
                }
                try {
                  socket = connect(address.port, "127.0.0.1");
                  await once(socket, "connect", { signal });
                  const upgraded = once(socket, "data", { signal });
                  socket.write(
                    "GET /repo.git/ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n",
                  );
                  await upgraded;
                  return published;
                } catch (error) {
                  socket?.destroy();
                  peer?.destroy();
                  await actual.closeWireServer(published.server);
                  throw error;
                }
              },
            };
          },
        );
        vi.doMock(qaApiModuleId, () => ({
          QA_EVIDENCE_FILENAME: "qa-evidence.json",
          ...mockBus(async () => {
            cleaned.push("bus");
            cleanupStarted.resolve();
          }),
          startQaMockOpenAiServer: async () => ({
            baseUrl: "http://127.0.0.1:1",
            stop: cleanupStep(cleaned, "provider"),
          }),
          createQaGatewayChild: () => ({
            start: reject(new Error("generation startup failed")),
            stop: async () => {
              cleaned.push("gateway");
              if (shutdown === "rejected") {
                throw new Error("generation shutdown rejected");
              }
              return shutdown === "unconfirmed"
                ? { process: "unconfirmed", errors: [new Error("generation shutdown unconfirmed")] }
                : { process: "never-spawned", errors: [] };
            },
          }),
        }));
        const release = () => {
          socket?.destroy();
          peer?.destroy();
          cleanupStarted.resolve();
        };
        signal.addEventListener("abort", release, { once: true });
        const operation = fixture.run(async () => {
          const { runWorkerInferenceGeneration } =
            await import("../e2e/qa-lab/runtime/worker-inference-generation-reload.js");
          // An import cannot be cancelled. A late completion must not start a proof.
          signal.throwIfAborted();
          return await runWorkerInferenceGeneration({
            artifactBase: path.join(root, "evidence"),
            repoRoot: process.cwd(),
          });
        });
        try {
          signal.throwIfAborted();
          // Import/publication failure also ends readiness; neither guarantees a writer existed.
          await Promise.race([cleanupStarted.promise, operation]);
          signal.throwIfAborted();
          await removal;
          expect(serverJoined).toBe(false);
          await expect(fs.stat(workspaceRoot)).resolves.toBeDefined();
        } finally {
          const closed = [socket, peer].map((stream) =>
            stream && !stream.closed ? once(stream, "close") : Promise.resolve(),
          );
          release();
          try {
            await Promise.all(closed);
            await operation;
          } finally {
            signal.removeEventListener("abort", release);
          }
        }
        expect(serverJoined).toBe(true);
        expect(cleaned).toEqual(["gateway", "provider", "bus"]);
        expectFailure(written, "generation startup failed");
        if (shutdown === "joined") {
          await expect(fs.stat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          await expect(fs.stat(workspaceRoot)).resolves.toBeDefined();
          expect(written[0]?.details).toContain(`generation shutdown ${shutdown}`);
        }
      }),
  );

  it("records compaction startup and cleanup failures after joining the provider", ({ signal }) =>
    fixture.run(async () => {
      const root = await tempRoot("qa-compaction-cleanup-");
      const repoRoot = path.join(root, "repo");
      await fs.mkdir(path.join(repoRoot, "dist", "plugin-sdk"), { recursive: true });
      await fs.writeFile(path.join(repoRoot, "dist", "index.js"), "");
      await fs.writeFile(path.join(repoRoot, "dist", "plugin-sdk", "qa-lab.js"), "");
      for (const key of [
        "HOME",
        "OPENCLAW_HOME",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_OAUTH_DIR",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
      ]) {
        vi.stubEnv(key, path.join(root, "home"));
      }
      const cleaned: string[] = [];
      let providerUrl: string | undefined;
      const written = mockEvidence();
      vi.doMock(qaApiModuleId, () => ({
        ...mockBus(cleanupStep(cleaned, "bus", new Error("bus cleanup failed"))),
        createQaGatewayChild: () => ({
          start: async (params: { providerBaseUrl: string }) => {
            providerUrl = params.providerBaseUrl;
            const response = await fetch(`${providerUrl}/models`);
            expect(response.status).toBe(200);
            await response.arrayBuffer();
            throw new Error("compaction startup failed");
          },
          stop: cleanupResult(cleaned, {
            process: "never-spawned",
            errors: [new Error("gateway cleanup failed")],
          }),
        }),
      }));
      const { runGatewayCompactionAbort } =
        await import("../e2e/qa-lab/runtime/gateway-compaction-abort.js");
      signal.throwIfAborted();
      expect(
        await runGatewayCompactionAbort([
          "--repo-root",
          repoRoot,
          "--artifact-base",
          ".artifacts/cleanup-proof",
        ]),
      ).toBe(1);
      expect(cleaned).toEqual(["gateway", "bus"]);
      expect(providerUrl).toBeDefined();
      await expect(fetch(`${providerUrl}/models`)).rejects.toThrow();
      expectFailure(
        written,
        "compaction startup failed",
        "gateway cleanup failed",
        "bus cleanup failed",
      );
      await expect(fs.stat(path.join(root, "gateway-stopped"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }));

  it.each(["diagnostic", "rejection"])(
    "stops the WebChat bus after startup fails and owner cleanup reports a %s",
    (mode) =>
      fixture.run(async () => {
        const startupError = new Error("WebChat gateway startup failed");
        const gatewayError = new Error("WebChat gateway cleanup failed");
        const busError = new Error("WebChat bus cleanup failed");
        const cleaned: string[] = [];
        const { bodies, cleanups } = captureTests<() => Promise<void>>(true);
        vi.doMock(qaApiModuleId, () => mockBus(cleanupStep(cleaned, "bus", busError), 43210));
        vi.doMock(qaRuntimeModuleId, () => ({
          createQaLiveLaneGateway: () => ({
            start: reject(startupError),
            stop: async () => {
              cleaned.push("gateway");
              if (mode === "rejection") {
                throw gatewayError;
              }
              return { errors: [gatewayError] };
            },
          }),
        }));
        vi.doMock("../../src/gateway/client.js", () => ({ GatewayClient: vi.fn() }));

        await import("../e2e/qa-lab/runtime/webchat-media-artifacts.e2e.test.js");
        expect(bodies).toHaveLength(1);
        expect(cleanups).toHaveLength(1);
        await expect(bodies[0]!()).rejects.toBe(startupError);
        const cleanupError: unknown = await cleanups[0]!().catch((error: unknown) => error);
        expect(cleaned).toEqual(["gateway", "bus"]);
        expect(errorTree(cleanupError)).toEqual(expect.arrayContaining([gatewayError, busError]));
      }),
  );

  it("returns the body value after completing all cleanup phases", async () => {
    const value = { fixture: "result" };
    const cleaned: string[] = [];
    await expect(
      runQaGatewayFixture(
        async () => {
          cleaned.push("body");
          return value;
        },
        cleanupStep(cleaned, "gateway"),
        cleanupStep(cleaned, "provider"),
      ),
    ).resolves.toBe(value);
    expect(cleaned).toEqual(["body", "gateway", "provider"]);
  });

  it("retains the original cleanup-only error and finishes cleanup", async () => {
    const failure = new Error("cleanup failed");
    const lastCleanup = vi.fn();
    await expect(runQaGatewayFixture(noop, reject(failure), lastCleanup)).rejects.toBe(failure);
    expect(lastCleanup).toHaveBeenCalledOnce();
  });

  it("settles ordered releases and browser cleanup before stopping every remaining owner", async () => {
    const bodyError = new Error("body failed");
    const releaseError = new Error("patch release failed");
    const contextError = new Error("context close failed");
    const browserError = new Error("browser close failed");
    const gatewayError = new Error("gateway finalization failed");
    const events: string[] = [];
    const contextClosing = createDeferred();
    const releaseContext = createDeferred();
    const result = runQaGatewayFixture(
      reject(bodyError),
      cleanupStep(events, "release", releaseError),
      async () => {
        events.push("context-closing");
        contextClosing.resolve();
        await releaseContext.promise;
        events.push("context-settled");
        throw contextError;
      },
      cleanupStep(events, "browser", browserError),
      cleanupStep(events, "node"),
      () =>
        stopQaGatewayFixture({
          stop: cleanupResult(events, { errors: [gatewayError] }),
        }),
      cleanupStep(events, "provider"),
    ).catch((error: unknown) => error);
    await contextClosing.promise;
    const beforeSettlement = [...events];
    releaseContext.resolve();
    const failure = await result;
    expect(beforeSettlement).toEqual(["release", "context-closing"]);
    expect(events).toEqual([
      "release",
      "context-closing",
      "context-settled",
      "browser",
      "node",
      "gateway",
      "provider",
    ]);
    expect(errorTree(failure)).toEqual(
      expect.arrayContaining([bodyError, releaseError, contextError, browserError, gatewayError]),
    );
  });

  it("retains startup and finalization errors through the actual OTel fixture", (context) =>
    fixture.run(async () => {
      const startupError = new Error("fixture startup failed");
      const finalizationError = new Error("fixture finalization failed");
      const cleaned: string[] = [];
      const { bodies, cleanups } = captureTests<FixtureBody>();
      const finished: Array<Parameters<TestContext["onTestFinished"]>[0]> = [];
      const registry = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null,
        kill() {
          cleaned.push("registry");
          registry.exitCode = 0;
          registry.emit("exit", 0, null);
          return true;
        },
      });
      let receiverCount = 0;
      vi.doMock("node:child_process", () => ({
        execFile: (...args: unknown[]) => {
          const callback = args.at(-1);
          if (typeof callback === "function") {
            callback(null, "", "");
          }
        },
        spawn: () => {
          queueMicrotask(() => registry.emit("message", 43210));
          return registry;
        },
      }));
      vi.doMock("node:fs/promises", () => ({
        copyFile: noop,
        cp: noop,
        mkdir: noop,
        mkdtemp: vi
          .fn()
          .mockResolvedValueOnce("/qa-fixture/scratch")
          .mockResolvedValueOnce("/qa-fixture/seed"),
        readdir: async () => ["diagnostics-otel.tgz"],
        readFile: async () => JSON.stringify({ version: "1.0.0" }),
        rm: async (target: string) => {
          cleaned.push(target);
        },
        symlink: noop,
        writeFile: noop,
      }));
      vi.doMock(qaApiModuleId, () => ({
        createQaGatewayChild: () => ({
          start: reject(startupError),
          stop: cleanupResult(cleaned, { errors: [finalizationError] }),
        }),
        startQaMockOpenAiServer: async () => ({
          baseUrl: "http://127.0.0.1:43211",
          stop: cleanupStep(cleaned, "provider"),
        }),
      }));
      vi.doMock("../../scripts/e2e/lib/plugin-index-sqlite.mjs", () => ({
        readPluginInstallRecords: () => ({}),
      }));
      vi.doMock("../e2e/qa-lab/runtime/otel-test-support.js", () => ({
        startLocalOtlpReceiver: () => {
          const label = `receiver-${receiverCount++}`;
          return {
            listen: async () => 43212,
            close: cleanupStep(cleaned, label),
          };
        },
      }));

      await import("../e2e/qa-lab/runtime/diagnostics-otel-install-runtime.e2e.test.js");
      expect(bodies).toHaveLength(2);
      expect(cleanups).toHaveLength(1);
      let failure: unknown;
      const finishErrors: unknown[] = [];
      try {
        failure = await bodies[0]!({
          signal: context.signal,
          onTestFinished: (hook) => {
            finished.push(hook);
          },
        }).catch((error: unknown) => error);
      } finally {
        for (const hook of finished.toReversed()) {
          await Promise.resolve()
            .then(() => hook(context))
            .catch((error: unknown) => finishErrors.push(error));
        }
        for (const cleanup of cleanups) {
          await cleanup();
        }
      }
      expect(cleaned).toEqual([
        "gateway",
        "provider",
        "registry",
        "receiver-0",
        "receiver-1",
        "/qa-fixture/scratch",
        "/qa-fixture/seed",
      ]);
      expect(errorTree(failure)).toEqual(expect.arrayContaining([startupError, finalizationError]));
      expect(errorTree(new AggregateError(finishErrors))).toContain(finalizationError);
    }));
});
