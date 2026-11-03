import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  saveExecApprovals,
  testing as execApprovalsStoreTesting,
} from "../infra/exec-approvals-store.test-support.js";
import { clearExecutablePathCache } from "../infra/executable-path.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { NodeHostConfig } from "./config.js";
import type { NodeHostGatewayConnection } from "./connection.js";
import * as pluginNodeHost from "./plugin-node-host.js";

const fixture = vi.hoisted(() => ({
  loadConfig: vi.fn<() => Promise<NodeHostConfig | null>>(),
  prepare: vi.fn(),
  start: vi.fn(),
  handleInvoke: vi.fn<typeof import("./invoke.js").handleInvoke>(),
  input: undefined as EventEmitter | undefined,
  runtime: {
    invoke: vi.fn(),
    handleInput: vi.fn(),
    cancel: vi.fn(),
    cancelAll: vi.fn(async () => undefined),
    updateGatewayConnection: vi.fn(),
    close: vi.fn(),
  },
}));
vi.mock("node:readline", () => ({ createInterface: () => fixture.input }));
vi.mock("./startup-state-readiness.js", () => ({ ensureNodeHostStateReady: () => {} }));
vi.mock("./config.js", () => ({ loadNodeHostConfig: fixture.loadConfig }));
vi.mock("./runtime.js", () => ({ prepareNodeHostRuntime: fixture.prepare }));
vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));
vi.mock("../infra/terminal-file-upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/terminal-file-upload.js")>()),
  ensureTerminalUploadCleanup: async () => {},
}));
vi.mock("./invoke.js", () => ({ handleInvoke: fixture.handleInvoke }));
vi.mock("./mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp.js")>()),
  startNodeHostMcpManager: async () => ({ descriptors: [], close: async () => {} }),
}));
vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: async () => {},
  invokeRegisteredNodeHostCommand: async () => null,
  isRegisteredNodeHostCommandDuplex: () => false,
  listRegisteredNodeHostCapsAndCommands: () => ({ caps: [], commands: [], nodePluginTools: [] }),
  notifyRegisteredNodeHostCommandDisconnect: async () => {},
  watchRegisteredNodeHostCommandAvailability: () => () => {},
}));
import { runNodeHostWorker } from "./worker.js";

const { prepareNodeHostRuntime } =
  await vi.importActual<typeof import("./runtime.js")>("./runtime.js");

beforeEach(() => {
  vi.clearAllMocks();
  fixture.loadConfig.mockResolvedValue(null);
  fixture.runtime.close.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type PreparedRuntime = Awaited<ReturnType<typeof import("./runtime.js").prepareNodeHostRuntime>>;
const gateway = {
  url: "wss://gateway.example.test",
  protocol: 4,
  capabilities: [],
};
const currentGateway = { ...gateway, url: `${gateway.url}/current` };
const readyMessage = (messages: Record<string, unknown>[]) =>
  messages.find((message) => message.type === "ready");
const messagesOfType = (messages: Record<string, unknown>[], type: string) =>
  messages.filter((message) => message.type === type);
const runnerPublication = (workerHost: object, generation?: number) =>
  expect.objectContaining({
    type: "gateway-request",
    ...(generation === undefined ? {} : { generation }),
    method: "node.runnerInventory.update",
    params: expect.objectContaining({ workerHost: expect.objectContaining(workerHost) }),
  });

function startWorkerFixture(
  workerHostingEnabled = true,
  workerHostingDisabledReason?: string,
  options: {
    prepared?: PreparedRuntime;
    desktopSharingEnabled?: boolean;
    initialWorkerCapacity?: { total: number; available: number } | null;
    gatewayResponse?: (
      message: Record<string, unknown>,
    ) => { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
  } = {},
) {
  // The private worker owns stdin; this shared test process does not.
  const destroyStdin = vi.spyOn(process.stdin, "destroy").mockReturnValue(process.stdin);
  const events = new EventEmitter();
  const input = Object.assign(events, {
    close: () => {
      events.emit("close");
    },
  });
  fixture.input = input;
  const send = (message: object) => input.emit("line", JSON.stringify(message));
  const connect = (generation: number, connection: NodeHostGatewayConnection | null = gateway) =>
    send({ type: "gateway-connection", generation, connection });
  const messages: Array<Record<string, unknown>> = [];
  const messageEvents = new EventEmitter();
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    const message = JSON.parse(String(chunk));
    messages.push(message);
    messageEvents.emit("message", message);
    if (message.type === "gateway-request") {
      queueMicrotask(() =>
        send({
          type: "gateway-response",
          generation: message.generation,
          id: message.id,
          ...(options.gatewayResponse?.(message) ?? { ok: true, result: {} }),
        }),
      );
    }
    return true;
  });
  fixture.start.mockImplementation((callbacks) => {
    if (workerHostingEnabled && options.initialWorkerCapacity !== null) {
      callbacks.onRunnerCapacityChanged?.(
        options.initialWorkerCapacity ?? { total: 2, available: 2 },
      );
    }
    return fixture.runtime;
  });
  fixture.prepare.mockResolvedValue(
    options.prepared ?? {
      manifest: { commands: ["system.run"], caps: ["system"], pathEnv: "/bin" },
      workerHostingEnabled,
      workerHostingDisabledReason,
      initialInventory: { skills: [], pluginTools: [] },
      start: fixture.start,
    },
  );
  const previousExitCode = process.exitCode;
  const interruptListeners = process.listeners("SIGINT");
  const terminateListeners = process.listeners("SIGTERM");
  const running = runNodeHostWorker({ desktopSharingEnabled: options.desktopSharingEnabled });
  return {
    send,
    connect,
    ready: () =>
      vi.waitFor(() => expect(messages.some((message) => message.type === "ready")).toBe(true)),
    messages,
    messageEvents,
    stderr,
    stdout,
    stop: async () => {
      try {
        input.close();
        await running;
        expect(destroyStdin).toHaveBeenCalled();
        if (!options.prepared) {
          expect(fixture.runtime.close).toHaveBeenCalledOnce();
          expect(fixture.runtime.updateGatewayConnection).toHaveBeenLastCalledWith();
        }
        expect(process.listeners("SIGINT")).toEqual(interruptListeners);
        expect(process.listeners("SIGTERM")).toEqual(terminateListeners);
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  };
}

async function withWorker(
  run: (worker: ReturnType<typeof startWorkerFixture>) => Promise<void>,
  ...options: Parameters<typeof startWorkerFixture>
) {
  const worker = startWorkerFixture(...options);
  try {
    await worker.ready();
    await run(worker);
  } finally {
    await worker.stop();
  }
}

it("refreshes runner facts only for the current private bridge generation", async () => {
  await withWorker(async ({ send, connect, messages }) => {
    connect(2);
    await setImmediate();
    const publications = () =>
      messages.filter((message) => message.method === "node.runnerInventory.update");
    expect(publications()).toHaveLength(1);
    const cancelsBefore = fixture.runtime.cancelAll.mock.calls.length;
    send({ type: "runner-inventory-refresh", generation: 1 });
    await setImmediate();
    expect(publications()).toHaveLength(1);
    send({ type: "runner-inventory-refresh", generation: 2 });
    await setImmediate();
    expect(publications()).toHaveLength(2);
    expect(publications().at(-1)).toMatchObject({
      generation: 2,
      params: { workerHost: { enabled: true, capacity: { total: 2, available: 2 } } },
    });
    expect(fixture.runtime.cancelAll).toHaveBeenCalledTimes(cancelsBefore);
    connect(3, null);
    send({ type: "runner-inventory-refresh", generation: 3 });
    await setImmediate();
    expect(publications()).toHaveLength(2);
  });
});

it("keeps the private app worker unrestricted by a saved headless command allowlist", async () => {
  fixture.loadConfig.mockResolvedValue({
    version: 1,
    nodeId: "headless-node",
    commands: ["openclaw.sessions.list.v1"],
  });
  vi.spyOn(pluginNodeHost, "listRegisteredNodeHostCapsAndCommands").mockReturnValue({
    commands: ["openclaw.sessions.list.v1"],
    caps: ["sessions"],
    nodePluginTools: [],
  });
  fixture.prepare.mockImplementationOnce(async (params) => ({
    ...(await prepareNodeHostRuntime({
      ...params,
      config: {
        nodeHost: { workerRuns: { enabled: true, isolation: "none" }, skills: { enabled: false } },
      },
      env: {},
    })),
    start: fixture.start,
  }));
  await withWorker(async ({ messages }) => {
    expect.soft(readyMessage(messages)).toMatchObject({
      manifest: { commands: expect.arrayContaining(["system.run"]) },
    });
    const prepared = await fixture.prepare.mock.results[0]?.value;
    expect.soft(prepared.workerHostingEnabled).toBe(true);
    expect.soft(prepared.restrictedSurface).toBeUndefined();
  });
});

it.each([
  { desktopSharingEnabled: undefined, configured: false, enabled: false },
  { desktopSharingEnabled: false, configured: true, enabled: false },
])(
  "publishes the app's desktop preference in the worker manifest: $desktopSharingEnabled",
  async ({ desktopSharingEnabled, configured, enabled }) => {
    fixture.prepare.mockImplementationOnce(async (params) => ({
      ...(await prepareNodeHostRuntime({
        ...params,
        config: { desktop: { host: { enabled: configured } } },
        env: {},
        platform: "darwin",
      })),
      start: fixture.start,
    }));
    await withWorker(
      async ({ messages }) => {
        expect(readyMessage(messages)).toMatchObject({
          manifest: {
            commands: enabled
              ? expect.arrayContaining(["desktop.stream"])
              : expect.not.arrayContaining(["desktop.stream"]),
          },
        });
      },
      false,
      undefined,
      { desktopSharingEnabled },
    );
  },
);

it("publishes hosting through the app route and retires it on disconnect", async () => {
  const { send, connect, ready, messages, stderr, stop } = startWorkerFixture();
  const resumeInvocation = createDeferredCore();
  const capacityPublished = createDeferredCore();
  try {
    await ready();
    expect(readyMessage(messages)).toMatchObject({
      workerHostingEnabled: true,
    });
    const connection = {
      ...currentGateway,
      capabilities: ["node.worker.bundleRetention.v1"],
    };
    connect(1, connection);
    await vi.waitFor(() => expect(messages).toContainEqual(runnerPublication({ enabled: true })));
    fixture.runtime.invoke.mockImplementationOnce(async () => {
      await resumeInvocation.promise;
      fixture.start.mock.calls[0]?.[0].onRunnerCapacityChanged({ total: 2, available: 1 });
      capacityPublished.resolve();
    });
    send({
      type: "invoke",
      generation: 1,
      request: { id: "old-route", nodeId: "node", command: "system.run" },
    });
    connect(2, null);
    expect(fixture.runtime.cancelAll).toHaveBeenCalled();
    expect(fixture.runtime.updateGatewayConnection).toHaveBeenLastCalledWith();
    connect(3, connection);
    await setImmediate();
    const callbacks = fixture.start.mock.calls[0]?.[0];
    if (!callbacks) {
      throw new Error("runtime was not started");
    }
    const count = messages.length;
    // Capacity is owned by the supervisor; cleanup from an old invocation can
    // notify it after reconnect without acquiring that invocation's authority.
    resumeInvocation.resolve();
    await capacityPublished.promise;
    await vi.waitFor(() =>
      expect(messages.slice(count)).toContainEqual(
        runnerPublication({ capacity: { total: 2, available: 1 } }, 3),
      ),
    );
    callbacks.onRunnerCapacityChanged({ total: 2, available: 0 });
    expect(messagesOfType(messages, "worker-hosting")).toEqual([]);
    callbacks.onManifestChanged({ commands: ["system.run"], caps: ["system"], pathEnv: "/bin" });
    send({
      type: "invoke",
      generation: 3,
      request: { id: "stale", nodeId: "node", command: "system.worker.start" },
    });
    expect(fixture.runtime.invoke).toHaveBeenCalledTimes(1);
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    resumeInvocation.resolve();
    await stop();
  }
});

it("reports hosting only after supervisor capacity exists", async () => {
  const { ready, messages, stop } = startWorkerFixture(true, undefined, {
    initialWorkerCapacity: null,
  });
  try {
    await ready();
    expect(readyMessage(messages)).toMatchObject({
      workerHostingEnabled: false,
    });
    expect(messagesOfType(messages, "worker-hosting")).toEqual([]);
    const callbacks = fixture.start.mock.calls[0]?.[0];
    callbacks.onRunnerCapacityChanged({ total: 2, available: 0 });
    callbacks.onRunnerCapacityChanged({ total: 2, available: 1 });
    expect(messagesOfType(messages, "worker-hosting")).toEqual([
      { type: "worker-hosting", enabled: true },
    ]);
  } finally {
    await stop();
  }
  expect(messages.findLast((message) => message.type === "worker-hosting")).toEqual({
    type: "worker-hosting",
    enabled: false,
  });
});

it.runIf(process.platform !== "win32").for([
  { scenario: "same Gateway reconnect", target: "a", elapsedMs: 0, rejectRefresh: false },
  { scenario: "replacement within cache TTL", target: "b", elapsedMs: 0, rejectRefresh: false },
  { scenario: "replacement refresh failure", target: "b", elapsedMs: 90_001, rejectRefresh: true },
])(
  "scopes skill-authorized execution to the worker connection: $scenario",
  async (scenario, { signal }) => {
    await withTestDir({ prefix: "openclaw-skill-exec-" }, async (dir) => {
      await withEnvAsync(
        {
          OPENCLAW_HOME: dir,
          OPENCLAW_STATE_DIR: path.join(dir, "state"),
          OPENCLAW_NODE_EXEC_HOST: undefined,
          OPENCLAW_NODE_EXEC_FALLBACK: "0",
          PATH: "/usr/bin:/bin",
        },
        async () => {
          closeOpenClawStateDatabaseForTest();
          execApprovalsStoreTesting.reset();
          const now = Date.now;
          let elapsedMs = 0;
          vi.spyOn(Date, "now").mockImplementation(() => now() + elapsedMs);
          let stop: (() => Promise<void>) | undefined;
          try {
            fs.accessSync(fs.realpathSync("/usr/bin/true"), fs.constants.X_OK);
            setRuntimeConfigSnapshot({ tools: { exec: { mode: "allowlist" } } });
            saveExecApprovals({
              version: 1,
              defaults: {
                security: "allowlist",
                ask: "off",
                askFallback: "deny",
                autoAllowSkills: true,
              },
              agents: {},
            });
            // Exec-host selection is captured on import. This lane exercises real
            // Node policy/commit/spawn; native app execution has its own proof.
            const { handleInvoke } =
              await vi.importActual<typeof import("./invoke.js")>("./invoke.js");
            fixture.handleInvoke.mockImplementation(handleInvoke);
            const prepared = await prepareNodeHostRuntime({
              config: { nodeHost: { skills: { enabled: false } } },
            });
            let rejectSameGatewayRefresh = false;
            const unavailable = {
              ok: false,
              error: { code: "UNAVAILABLE", message: "Gateway unavailable" },
            } as const;
            const worker = startWorkerFixture(false, undefined, {
              prepared,
              gatewayResponse: (message) => {
                if (message.method !== "skills.bins") {
                  return { ok: true, result: {} };
                }
                if (message.generation === 1 || scenario.target === "a") {
                  return rejectSameGatewayRefresh
                    ? unavailable
                    : { ok: true, result: { bins: ["true"] } };
                }
                return scenario.rejectRefresh ? unavailable : { ok: true, result: { bins: [] } };
              },
            });
            stop = worker.stop;
            const { send, messages } = worker;
            const connect = (generation: number, target: string) => {
              worker.connect(generation, {
                url: `wss://gateway-${target}.example.test`,
                protocol: 4,
                capabilities: [],
              });
            };
            const invoke = async (generation: number, id: string) => {
              const response = createDeferredCore<Record<string, unknown>>();
              const onMessage = (message: Record<string, unknown>) => {
                if (
                  message.type === "invoke-result" &&
                  (message.result as { id?: string } | undefined)?.id === id
                ) {
                  response.resolve(message);
                }
              };
              worker.messageEvents.on("message", onMessage);
              try {
                send({
                  type: "invoke",
                  generation,
                  request: {
                    id,
                    nodeId: "node",
                    command: "system.run",
                    paramsJSON: JSON.stringify({
                      // A shell-wrapped `true` has independent builtin trust.
                      // Bare argv requires the actual skill entry in this lane.
                      command: ["true"],
                      cwd: dir,
                      agentId: "main",
                      sessionKey: "agent:main:skill-trust-proof",
                      runId: id,
                      timeoutMs: 2_000,
                    }),
                  },
                });
                const message = await withinTest(response.promise, signal);
                expect(message).toMatchObject({ generation, result: { id } });
                return message.result as {
                  ok: boolean;
                  payloadJSON?: string;
                  error?: { code: string; message: string };
                };
              } finally {
                worker.messageEvents.off("message", onMessage);
              }
            };
            const expectExecuted = (result: Awaited<ReturnType<typeof invoke>>) => {
              expect(result).toMatchObject({ ok: true });
              expect(JSON.parse(result.payloadJSON ?? "null")).toMatchObject({
                exitCode: 0,
                success: true,
              });
            };
            await worker.ready();
            connect(1, "a");
            expectExecuted(await invoke(1, "a-warm"));
            worker.connect(2, null);
            // Advance expiry only after the real process has completed.
            elapsedMs = scenario.elapsedMs;
            connect(3, scenario.target);
            const replacement = await invoke(3, "new-invoke");
            if (scenario.target === "a") {
              expectExecuted(replacement);
              const skillRequests = () =>
                messages.filter((message) => message.method === "skills.bins");
              const refreshes = skillRequests().length;
              elapsedMs = 90_001;
              rejectSameGatewayRefresh = true;
              expectExecuted(await invoke(3, "a-refresh-failed"));
              expect(skillRequests()).toHaveLength(refreshes + 1);
            } else {
              expect(replacement).toMatchObject({
                ok: false,
                error: { code: "SYSTEM_RUN_DENIED", message: "SYSTEM_RUN_DENIED: allowlist miss" },
              });
              const denied = messages.findLast((message) => message.type === "node-event");
              expect(denied).toMatchObject({ generation: 3, event: { event: "exec.denied" } });
              expect(
                JSON.parse((denied!.event as { payloadJSON: string }).payloadJSON),
              ).toMatchObject({
                runId: "new-invoke",
                host: "node",
                reason: "allowlist-miss",
              });
            }
            expect(messagesOfType(messages, "ready")).toHaveLength(1);
          } finally {
            try {
              await stop?.();
            } finally {
              fixture.handleInvoke.mockReset();
              execApprovalsStoreTesting.reset();
              closeOpenClawStateDatabaseForTest();
              clearRuntimeConfigSnapshot();
              clearExecutablePathCache();
            }
          }
        },
      );
    });
  },
);

it.each(["prepared failure", "later failure"] as const)(
  "keeps worker hosting diagnostics local across reconnects: %s",
  async (scenario) => {
    const secret = "fixture-secret";
    const action = "install and start the engine";
    const reason = `Docker authentication failed (password=${secret}); ${action}`;
    const preparedFailure = scenario === "prepared failure";
    const laterFailure = scenario === "later failure";
    await withWorker(
      async ({ connect, messages, stderr, stdout }) => {
        const expectDiagnostic = () => {
          expect(stderr).toHaveBeenCalledOnce();
          const diagnostic = String(stderr.mock.calls[0]?.[0]);
          expect(diagnostic).toContain(
            "node host worker hosting disabled: Docker authentication failed",
          );
          expect(diagnostic).toContain(action);
          expect(diagnostic).not.toContain(secret);
        };

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ type: "ready", workerHostingEnabled: laterFailure });
        if (preparedFailure) {
          expectDiagnostic();
          expect(stderr.mock.invocationCallOrder[0]).toBeLessThan(
            stdout.mock.invocationCallOrder[0]!,
          );
        } else {
          expect(stderr).not.toHaveBeenCalled();
        }
        const inventories = () =>
          messages.filter((message) => message.method === "node.runnerInventory.update");
        connect(1, currentGateway);
        await setImmediate();
        if (laterFailure) {
          expect(inventories()).toHaveLength(1);
          expect(inventories()[0]?.params).toMatchObject({ workerHost: { enabled: true } });
          fixture.start.mock.calls[0]?.[0].onWorkerHostingDisabled(reason);
          fixture.start.mock.calls[0]?.[0].onRunnerCapacityChanged({ total: 2, available: 2 });
          await setImmediate();
          expectDiagnostic();
        }
        const disabledInventory = expect.objectContaining({ workerHost: { enabled: false } });
        expect(inventories()).toHaveLength(laterFailure ? 2 : 1);
        expect(inventories().at(-1)?.params).toEqual(disabledInventory);
        connect(2, null);
        connect(3, currentGateway);
        await setImmediate();
        expect(inventories()).toHaveLength(laterFailure ? 3 : 2);
        expect(inventories().at(-1)).toMatchObject({ generation: 3, params: disabledInventory });
        expectDiagnostic();
        const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(output).not.toContain(secret);
        expect(output).not.toContain(reason);
        expect(output).not.toContain(action);
        expect(output).not.toContain("worker hosting disabled");
        expect(messagesOfType(messages, "ready")).toHaveLength(1);
        expect(messages.some((message) => message.type === "manifest")).toBe(false);
        expect(messagesOfType(messages, "worker-hosting")).toEqual(
          laterFailure ? [{ type: "worker-hosting", enabled: false }] : [],
        );
      },
      laterFailure,
      preparedFailure ? reason : undefined,
    );
  },
);
