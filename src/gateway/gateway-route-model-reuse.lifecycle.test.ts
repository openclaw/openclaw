import { getEventListeners } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, test, vi, type TestContext } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClientRequestOptions } from "./client.js";

type RouteBody = (context: Pick<TestContext, "signal" | "onTestFinished">) => Promise<unknown>;

test("cancellation during agent.wait joins the registered route body before teardown completes", (context) =>
  runQaGatewayTestFixture(
    context,
    async ({ signal: testSignal, createTempDir, verifyCleanup }) => {
      vi.resetModules();
      const root = createTempDir("route-model-cancellation-");
      const stateDir = path.join(root, "gateway");
      await fs.mkdir(stateDir);
      const cancel = new AbortController();
      const signal = AbortSignal.any([testSignal, cancel.signal]);
      const cancellation = new Error("route test canceled");
      const rpcFailure = new Error("gateway client stopped");
      const pendingRpc = createDeferred<never>();
      const rpcEntered = createDeferred();
      const clientClosing = createDeferred();
      const releaseClient = createDeferred();
      const instanceClosing = createDeferred();
      const releaseInstance = createDeferred();
      void pendingRpc.promise.catch(() => {});
      const sourceHooks: Array<Parameters<TestContext["onTestFinished"]>[0]> = [];
      // Capture the old registration only so a before-fix failure can release its resources.
      const rescueHooks: Array<() => Promise<void>> = [];
      const routeContext: TestContext = {
        ...context,
        signal,
        onTestFinished: (hook) => {
          sourceHooks.push(hook);
        },
      };
      const bodies = new Map<string, RouteBody>();
      let provider: Server | undefined;
      let config: OpenClawConfig | undefined;
      let stopped = false;
      let rpcSettled = false;
      let bodySettled = false;
      let teardownSettled = false;
      let complete = false;
      let importing: Promise<unknown> | undefined;
      let outcome: Promise<unknown> | undefined;
      let teardown: Promise<void> | undefined;
      const stop = vi.fn(() => {
        if (!stopped) {
          stopped = true;
          pendingRpc.reject(rpcFailure);
        }
      });
      const stopAndWait = vi.fn(async () => {
        stop();
        clientClosing.resolve();
        await releaseClient.promise;
      });
      const cleanupInstance = vi.fn(async () => {
        instanceClosing.resolve();
        await releaseInstance.promise;
        await fs.rm(stateDir, { recursive: true, force: true });
      });
      const request = vi.fn(
        async (method: string, _params?: unknown, options?: GatewayClientRequestOptions) => {
          switch (method) {
            case "models.list":
              return {
                models: Object.entries(config?.models?.providers ?? {}).flatMap(
                  ([providerId, value]) =>
                    value.models.map(({ id }) => ({ provider: providerId, id })),
                ),
              };
            case "routeModelProof.stats":
              return { counts: {}, reloadSettled: true };
            case "agent":
              return { runId: "held-route-run", status: "accepted" };
            case "agent.wait": {
              const requestSignal = options?.signal;
              const onAbort = () => {
                pendingRpc.reject(rpcFailure);
              };
              requestSignal?.addEventListener("abort", onAbort, { once: true });
              if (requestSignal?.aborted) {
                onAbort();
              }
              rpcEntered.resolve();
              try {
                return await pendingRpc.promise;
              } finally {
                rpcSettled = true;
                requestSignal?.removeEventListener("abort", onAbort);
              }
            }
            default:
              throw new Error("Unexpected route RPC: " + method);
          }
        },
      );
      const drain = async () => {
        for (const hook of sourceHooks.toReversed()) {
          await hook(routeContext);
        }
      };

      const vitest = await vi.importActual<typeof import("vitest")>("vitest");
      const metadata = await vi.importActual<
        typeof import("../../scripts/lib/local-build-metadata.mts")
      >("../../scripts/lib/local-build-metadata.mts");
      const head = "a".repeat(40);
      const dist = path.join(process.cwd(), "dist");
      const stamps = new Set(
        [metadata.BUILD_STAMP_FILE, metadata.RUNTIME_POSTBUILD_STAMP_FILE, "build-info.json"].map(
          (file) => path.join(dist, file),
        ),
      );
      const access = fs.access;
      const readFile = fs.readFile;
      vi.spyOn(fs, "access").mockImplementation(async (...args) => {
        if (args[0] !== path.join(dist, "index.js")) {
          await access(...args);
        }
      });
      vi.spyOn(fs, "readFile").mockImplementation(async (file, options) =>
        typeof file === "string" && stamps.has(file)
          ? JSON.stringify({ head, commit: head })
          : readFile(file, options),
      );
      vi.doMock("../../scripts/lib/local-build-metadata.mts", () => ({
        ...metadata,
        resolveGitHead: () => head,
      }));
      vi.doMock("vitest", () => ({
        ...vitest,
        afterEach: (cleanup: () => Promise<void>) => rescueHooks.push(cleanup),
        describe: (_name: string, body: () => void) => body(),
        it: (name: string, _options: unknown, body: RouteBody) => bodies.set(name, body),
      }));
      vi.doMock("node:http", async (original) => ({
        ...(await original<typeof import("node:http")>()),
        createServer: (listener: RequestListener) => {
          provider = createServer(listener);
          return provider;
        },
      }));
      vi.doMock("../../test/helpers/gateway-client.js", () => ({
        acquireGatewayTestClient: async () => ({ request, stop, stopAndWait }),
      }));
      vi.doMock("../../test/helpers/openclaw-test-instance.js", () => ({
        createOpenClawTestInstance: async () => ({
          port: 1,
          gatewayToken: "synthetic-token",
          url: "ws://127.0.0.1:1",
          child: { pid: 1 },
          state: {
            stateDir,
            workspaceDir: stateDir,
            writeConfig: async (value: OpenClawConfig) => {
              config = value;
            },
            writeAuthProfiles: async () => {},
          },
          entrypoint: async () => ["dist/index.js"],
          startGateway: async () => {},
          cleanup: cleanupInstance,
          logs: () => "controlled route Gateway",
        }),
      }));

      try {
        // Collect the actual runtime test; its callback and lifetime wiring remain real.
        importing = import("./gateway-route-model-reuse.test.js");
        await importing;
        signal.throwIfAborted();
        const route = bodies.get(
          "bounds stable resolution reuse and refreshes generation facts without suppressing dynamic preparation",
        );
        expect(route).toBeTypeOf("function");
        outcome = route!(routeContext).then(
          () => {
            bodySettled = true;
          },
          (error: unknown) => {
            bodySettled = true;
            return error;
          },
        );
        const endedEarly = outcome.then((error) => {
          if (error instanceof Error) {
            throw error;
          }
          throw new Error("Route body ended before the controlled gate", { cause: error });
        });
        void endedEarly.catch(() => {});
        await Promise.race([rpcEntered.promise, endedEarly]);

        const callsBeforeCancellation = request.mock.calls.length;
        cancel.abort(cancellation);
        await setImmediate();
        expect(rpcSettled, "cancellation must settle the pending agent.wait request").toBe(true);
        expect(sourceHooks).toHaveLength(1);
        teardown = verifyCleanup(drain).then(() => {
          teardownSettled = true;
        });
        void teardown.catch(() => {});
        await Promise.race([clientClosing.promise, endedEarly]);
        // One event-loop checkpoint exposes an incorrectly untracked body without a timeout.
        await setImmediate();
        expect(bodySettled).toBe(false);
        expect(teardownSettled).toBe(false);
        expect(cleanupInstance).not.toHaveBeenCalled();
        expect(existsSync(stateDir)).toBe(true);

        releaseClient.resolve();
        await Promise.race([instanceClosing.promise, endedEarly]);
        await setImmediate();
        expect(bodySettled).toBe(false);
        expect(teardownSettled).toBe(false);
        expect(provider?.listening).toBe(true);
        releaseInstance.resolve();

        expect(await outcome).toBe(rpcFailure);
        await teardown;
        expect(signal.reason).toBe(cancellation);
        expect(stopAndWait).toHaveBeenCalledOnce();
        expect(cleanupInstance).toHaveBeenCalledOnce();
        expect(request.mock.calls.filter(([method]) => method === "agent")).toHaveLength(1);
        expect(request.mock.calls).toHaveLength(callsBeforeCancellation);
        expect(request.mock.calls.at(-1)?.[0]).toBe("agent.wait");
        expect(provider?.listening).toBe(false);
        expect(existsSync(stateDir)).toBe(false);
        expect(getEventListeners(signal, "abort")).toEqual([]);
        complete = true;
      } finally {
        // Pre-fix rescue follows the failed oracle; it never supplies a passing cancellation.
        if (!complete) {
          cancel.abort(cancellation);
          stop();
          releaseClient.resolve();
          releaseInstance.resolve();
        }
        await Promise.allSettled([importing]);
        teardown ??= verifyCleanup(drain);
        const rescue = !complete
          ? (async () => {
              for (const hook of rescueHooks.toReversed()) {
                await hook();
              }
            })()
          : undefined;
        await Promise.allSettled([outcome, teardown, rescue]);
        const server = provider;
        if (!complete && server?.listening) {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      }
    },
    () => {
      vi.restoreAllMocks();
      for (const module of [
        "vitest",
        "node:http",
        "../../scripts/lib/local-build-metadata.mts",
        "../../test/helpers/gateway-client.js",
        "../../test/helpers/openclaw-test-instance.js",
      ]) {
        vi.doUnmock(module);
      }
      vi.resetModules();
    },
  ));
