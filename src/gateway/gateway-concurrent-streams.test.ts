import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import * as gatewayBenchChild from "../../scripts/lib/gateway-bench-child.js";
import { getFreePort } from "../../scripts/lib/gateway-bench-probes.js";
import { createGatewayWsClient } from "../../scripts/lib/gateway-ws-client.js";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata-paths.mts";
import { inspectManagedProcessGroup } from "../../scripts/lib/managed-child-process.mts";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { hasErrnoCode } from "../infra/errno.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type StreamFrame = {
  id?: string;
  type?: string;
  delta?: string;
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  response?: { id: string; status: string };
};

type MockProcessOwner = {
  child: ChildProcessWithoutNullStreams;
  closeObserved: boolean;
  error?: Error;
};

function ownMockProcess(child: ChildProcessWithoutNullStreams): MockProcessOwner {
  const owner: MockProcessOwner = { child, closeObserved: false };
  const onError = (error: Error) => {
    owner.error = error;
  };
  child.on("error", onError);
  child.once("close", () => {
    owner.closeObserved = true;
    child.off("error", onError);
  });
  return owner;
}

async function stopMockProcess(owner: MockProcessOwner): Promise<void> {
  // Only caller verification uses this deadline; stopChild can outlast it:
  // its Linux census has a separate timeout; synchronous Windows taskkill has none.
  const deadline = Date.now() + 2_000 + 1_000;
  await gatewayBenchChild.stopChild(owner.child);
  while (true) {
    const { child } = owner;
    const exited = child.exitCode !== null || child.signalCode !== null;
    // This mock and its checked-in imports spawn no descendants. Windows proof
    // is native leader/close/stdio, not a nominally dead POSIX group.
    const groupClosed =
      process.platform === "win32" ||
      inspectManagedProcessGroup(child, {
        deadlineAt: deadline,
        errorPolicy: "indeterminate",
      }) === "dead";
    if (
      exited &&
      owner.closeObserved &&
      child.stdin.closed &&
      child.stdout.closed &&
      child.stderr.closed &&
      groupClosed
    ) {
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("Mock provider shutdown unverified; Gateway state retained", {
        cause: owner.error,
      });
    }
    await gatewayBenchChild.delay(Math.min(10, remaining));
  }
}

async function cleanupConcurrentStreamResources(owners: {
  closeClient: () => Promise<void>;
  stopGateway: () => Promise<void>;
  stopMock: () => Promise<void>;
  settleStreams: () => Promise<unknown>;
  cleanupGateway: () => Promise<void>;
}): Promise<void> {
  let mockStopped = false;
  await runQaGatewayFixture(
    owners.closeClient,
    owners.stopGateway,
    async () => {
      await owners.stopMock();
      mockStopped = true;
    },
    owners.settleStreams,
    async () => {
      // The mock reads control files and appends request logs inside Gateway state.
      if (mockStopped) {
        await owners.cleanupGateway();
      }
    },
  );
}

const cases = [
  {
    endpoint: "/v1/chat/completions",
    sessionKey: "agent:main:fanout-alpha",
    marker: "FANOUT_ALPHA first second",
  },
  {
    endpoint: "/v1/responses",
    sessionKey: "agent:main:fanout-beta",
    marker: "FANOUT_BETA first second",
  },
] as const;

describe("Gateway concurrent HTTP streams", () => {
  it("retains backing state when mock shutdown resolves without native closure", (context) => {
    let gateway: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
    let mock: MockProcessOwner | undefined;
    return runQaGatewayTestFixture(
      context,
      async ({ signal, verifyCleanup }) => {
        const stateOwner = await createOpenClawTestInstance({
          name: "concurrent-stream-retention",
          signal,
          verifyCleanup,
        });
        gateway = stateOwner;
        signal.throwIfAborted();
        const controlPath = stateOwner.state.path("response-control.json");
        const control = JSON.stringify({
          scriptVersion: "retention-proof",
          hold: true,
          responses: [{ text: "retained" }],
        });
        await fs.writeFile(controlPath, control);
        signal.throwIfAborted();
        const processOwner = ownMockProcess(
          spawn(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
            cwd: process.cwd(),
            detached: process.platform !== "win32",
            env: {
              PATH: process.env.PATH,
              MOCK_PORT: "0",
              MOCK_RESPONSE_CONTROL: controlPath,
            },
          }),
        );
        mock = processOwner;
        processOwner.child.stderr.resume();
        const lines = createInterface({ input: processOwner.child.stdout });
        try {
          const [ready] = await once(lines, "line", {
            signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
          });
          expect(ready).toMatch(/^mock-openai listening on \d+$/);
        } finally {
          lines.close();
          processOwner.child.stdout.resume();
        }
        signal.throwIfAborted();
        const closeClient = vi.fn(async () => {});
        const stopGateway = vi.fn(() => stateOwner.stopGateway());
        const settleStreams = vi.fn(async () => {});
        const cleanupGateway = vi.fn(() => stateOwner.cleanup());
        const reportedStop = vi.spyOn(gatewayBenchChild, "stopChild").mockResolvedValue({
          exitCode: null,
          signal: "SIGKILL",
          exitedBeforeTeardown: false,
        });
        try {
          const cleanupOutcome = await cleanupConcurrentStreamResources({
            closeClient,
            stopGateway,
            stopMock: () => stopMockProcess(processOwner),
            settleStreams,
            cleanupGateway,
          }).then(
            () => ({ status: "fulfilled" }),
            (error: unknown) => ({ status: "rejected", error }),
          );
          expect(closeClient).toHaveBeenCalledOnce();
          expect(stopGateway).toHaveBeenCalledOnce();
          expect(settleStreams).toHaveBeenCalledOnce();
          expect(processOwner.child.exitCode).toBeNull();
          expect(processOwner.child.signalCode).toBeNull();
          expect(processOwner.closeObserved).toBe(false);
          expect(processOwner.child.pid).toBeTypeOf("number");
          expect(() => process.kill(processOwner.child.pid!, 0)).not.toThrow();
          if (process.platform !== "win32") {
            expect(
              inspectManagedProcessGroup(processOwner.child, { errorPolicy: "indeterminate" }),
            ).toBe("live");
          }
          await expect(fs.readFile(controlPath, "utf8")).resolves.toBe(control);
          expect(cleanupGateway).not.toHaveBeenCalled();
          expect(cleanupOutcome).toMatchObject({
            status: "rejected",
            error: { message: "Mock provider shutdown unverified; Gateway state retained" },
          });
        } finally {
          reportedStop.mockRestore();
        }
      },
      async () => {
        await cleanupConcurrentStreamResources({
          closeClient: async () => {},
          stopGateway: async () => {
            await gateway?.stopGateway();
          },
          stopMock: async () => {
            if (mock) {
              await stopMockProcess(mock);
            }
          },
          settleStreams: async () => {},
          cleanupGateway: async () => {
            await gateway?.cleanup();
          },
        });
        if (gateway) {
          await expect(fs.stat(gateway.state.root)).rejects.toMatchObject({ code: "ENOENT" });
        }
      },
    );
  }, 120_000);

  it("keeps both streams isolated while global observers retain every run", (context) => {
    const { signal } = context;
    const abort = new AbortController();
    let ownedGateway: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
    let client: ReturnType<typeof createGatewayWsClient> | undefined;
    let mock: MockProcessOwner | undefined;
    const streams: Array<{
      item: (typeof cases)[number];
      settled: Promise<PromiseSettledResult<StreamFrame[]>>;
    }> = [];
    const cancel = () => {
      abort.abort(signal.reason);
      client?.close();
    };
    signal.addEventListener("abort", cancel, { once: true });
    return runQaGatewayTestFixture(
      context,
      async ({ verifyCleanup }) => {
        signal.throwIfAborted();
        const cwd = process.cwd();
        const checkoutSha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd,
          encoding: "utf8",
        }).trim();
        // Require this checkout's complete runtime before the shared helper can
        // prepare a source fallback. The child must own one coherent built graph.
        await fs.access(path.join(cwd, "dist/index.js"));
        signal.throwIfAborted();
        for (const stamp of [BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE]) {
          const metadata = JSON.parse(await fs.readFile(path.join(cwd, "dist", stamp), "utf8"));
          signal.throwIfAborted();
          expect(metadata.head, stamp).toBe(checkoutSha);
        }
        const buildInfo = JSON.parse(
          await fs.readFile(path.join(cwd, "dist/build-info.json"), "utf8"),
        );
        expect(buildInfo.commit).toBe(checkoutSha);
        signal.throwIfAborted();
        const token = `fanout-${randomUUID()}`;
        const gateway = await createOpenClawTestInstance({
          name: "concurrent-streams",
          cwd,
          signal,
          verifyCleanup,
          gatewayToken: token,
          env: {
            OPENCLAW_GATEWAY_TOKEN: undefined,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
            OPENCLAW_TEST_CONSOLE: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          },
        });
        ownedGateway = gateway;
        signal.throwIfAborted();
        const { state, port } = gateway;
        const controlPath = state.path("response-control.json");
        const requestLogPath = state.path("provider-requests.jsonl");
        const events: AgentEventPayload[] = [];
        const writeControl = async (hold: boolean) => {
          signal.throwIfAborted();
          await fs.writeFile(
            `${controlPath}.next`,
            JSON.stringify({
              scriptVersion: "fanout-proof",
              hold,
              responses: cases.map(({ marker }) => ({ text: marker, chunkDelayMs: 100 })),
            }),
          );
          signal.throwIfAborted();
          await fs.rename(`${controlPath}.next`, controlPath);
          signal.throwIfAborted();
        };
        const requestBodies = async () => {
          const raw = await fs.readFile(requestLogPath, "utf8").catch((error: unknown) => {
            if (hasErrnoCode(error, "ENOENT")) {
              return "";
            }
            throw error;
          });
          return raw.trim()
            ? raw
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line).body as string)
            : [];
        };
        try {
          signal.throwIfAborted();
          expect(await gateway.entrypoint()).toEqual(["dist/index.js"]);
          signal.throwIfAborted();
          const mockPort = await getFreePort();
          signal.throwIfAborted();
          const provider = buildMockOpenAiResponsesProvider(
            `http://127.0.0.1:${mockPort}/v1`,
            "gpt-5.6-luna",
          );
          await writeControl(true);
          signal.throwIfAborted();
          mock = ownMockProcess(
            spawn(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
              cwd: process.cwd(),
              detached: process.platform !== "win32",
              env: {
                PATH: process.env.PATH,
                MOCK_PORT: String(mockPort),
                MOCK_RESPONSE_CONTROL: controlPath,
                MOCK_REQUEST_LOG: requestLogPath,
              },
            }),
          );
          mock.child.stdout.resume();
          mock.child.stderr.resume();
          await vi.waitFor(async () => {
            signal.throwIfAborted();
            expect(
              (await fetch(`http://127.0.0.1:${mockPort}/health`, { signal: abort.signal })).status,
            ).toBe(200);
          });
          const cfg = {
            gateway: {
              port,
              auth: { mode: "token", token },
              controlUi: { enabled: false },
              http: {
                endpoints: { chatCompletions: { enabled: true }, responses: { enabled: true } },
              },
            },
            hooks: { enabled: false },
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                skipBootstrap: true,
                maxConcurrent: 2,
                heartbeat: { every: "0m" },
                model: { primary: provider.modelRef },
                models: {
                  [provider.modelRef]: {
                    agentRuntime: { id: "openclaw" },
                    params: { transport: "sse", openaiWsWarmup: false },
                  },
                },
              },
            },
            models: {
              mode: "replace",
              providers: {
                [provider.providerId]: {
                  ...provider.config,
                  request: { allowPrivateNetwork: true },
                },
              },
            },
            plugins: { slots: { memory: "none" } },
            tools: { profile: "minimal" },
          } satisfies OpenClawConfig;
          signal.throwIfAborted();
          await state.writeConfig(cfg);
          signal.throwIfAborted();
          await gateway.startGateway();
          signal.throwIfAborted();
          client = createGatewayWsClient({
            url: gateway.url,
            onEvent: (event) => {
              if (event.event === "agent") {
                events.push(event.payload as AgentEventPayload);
              }
            },
          });
          await client.waitOpen();
          signal.throwIfAborted();
          const connected = await client.request("connect", {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: "gateway-client",
              displayName: "concurrent-stream-proof",
              version: "dev",
              platform: process.platform,
              mode: "backend",
            },
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write"],
            auth: { token },
          });
          signal.throwIfAborted();
          expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
          for (const [index, item] of cases.entries()) {
            signal.throwIfAborted();
            const subscribed = await client.request("sessions.messages.subscribe", {
              key: item.sessionKey,
            });
            signal.throwIfAborted();
            expect(subscribed.ok, JSON.stringify(subscribed.error)).toBe(true);
            signal.throwIfAborted();
            const body = {
              model: "openclaw:main",
              stream: true,
              ...(item.endpoint === "/v1/responses"
                ? { input: item.marker }
                : { messages: [{ role: "user", content: item.marker }] }),
            };
            const pending = (async () => {
              const response = await fetch(`http://127.0.0.1:${port}${item.endpoint}`, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                  "x-openclaw-session-key": item.sessionKey,
                },
                body: JSON.stringify(body),
                signal: abort.signal,
              });
              signal.throwIfAborted();
              expect(response.status).toBe(200);
              const wire = await response.text();
              signal.throwIfAborted();
              expect(wire.match(/^data: \[DONE\]$/gm)).toHaveLength(1);
              return wire
                .split("\n")
                .flatMap((line) =>
                  line.startsWith("data: ") && line !== "data: [DONE]"
                    ? [JSON.parse(line.slice(6)) as StreamFrame]
                    : [],
                );
            })();
            streams.push({
              item,
              settled: Promise.allSettled([pending]).then(([result]) => result!),
            });
            // Reserve each scripted response in arrival order, but hold both provider
            // requests open together before either may deliver a delta or terminal.
            await vi.waitFor(
              async () => {
                signal.throwIfAborted();
                expect(await requestBodies()).toHaveLength(index + 1);
              },
              {
                timeout: 30_000,
              },
            );
          }
          const requests = await requestBodies();
          signal.throwIfAborted();
          for (const [index, item] of cases.entries()) {
            expect(requests[index]).toContain(item.marker);
          }
          signal.throwIfAborted();
          await writeControl(false);
          for (const stream of streams) {
            signal.throwIfAborted();
            const { item } = stream;
            const settled = await stream.settled;
            signal.throwIfAborted();
            if (settled.status === "rejected") {
              throw settled.reason;
            }
            const frames = settled.value;
            const runId = frames[0]?.id ?? frames[0]?.response?.id;
            expect(runId).toEqual(expect.any(String));
            const text = frames
              .map((frame) => frame.delta ?? frame.choices?.[0]?.delta?.content ?? "")
              .join("");
            expect(text).toBe(item.marker);
            const terminals = frames.filter(
              (frame) =>
                frame.type === "response.completed" || frame.choices?.[0]?.finish_reason === "stop",
            );
            expect(terminals).toHaveLength(1);
            signal.throwIfAborted();
            const result = await client.request("agent.wait", {
              runId,
              timeoutMs: 10_000,
            });
            signal.throwIfAborted();
            expect(result.ok, JSON.stringify(result.error)).toBe(true);
            expect(result.payload).toMatchObject({ status: "ok" });
            await vi.waitFor(() => {
              signal.throwIfAborted();
              const own = events.filter((event) => event.runId === runId);
              const lifecycle = own.filter((event) => event.stream === "lifecycle");
              expect(lifecycle.filter((event) => event.data.phase === "start")).toHaveLength(1);
              expect(lifecycle.filter((event) => event.data.phase === "end")).toHaveLength(1);
              const assistant = own.filter((event) => event.stream === "assistant");
              expect(assistant[0]?.data.text).toBeTypeOf("string");
              let assistantText = "";
              for (const event of assistant) {
                if (typeof event.data.text === "string") {
                  assistantText = event.data.text;
                } else {
                  expect(event.data.delta).toBeTypeOf("string");
                  assistantText += String(event.data.delta);
                }
                expect(item.marker.startsWith(assistantText)).toBe(true);
              }
              expect(assistantText).toBe(item.marker);
            });
          }
        } catch (error) {
          console.error(gateway.logs());
          throw error;
        }
      },
      async () => {
        abort.abort();
        try {
          await cleanupConcurrentStreamResources({
            closeClient: async () => {
              if (client) {
                client.close();
                await closeGatewayTestWebSocket(client.ws);
              }
            },
            stopGateway: async () => {
              await ownedGateway?.stopGateway();
            },
            stopMock: async () => {
              if (mock) {
                await stopMockProcess(mock);
              }
            },
            settleStreams: () => Promise.all(streams.map((stream) => stream.settled)),
            cleanupGateway: async () => {
              await ownedGateway?.cleanup();
            },
          });
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      },
    );
  }, 120_000);
});
