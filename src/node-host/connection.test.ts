import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/schema/frames.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { CORE_WORKER_LAUNCH_TOOL_NAMES } from "../agents/tool-catalog.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import {
  NODE_RUNNER_INVENTORY_UPDATE_METHOD,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  parseNodeRunnerInventoryDeclaration,
  resolveNodeWorkerLaunchToolNames,
} from "../infra/node-runner-inventory.js";
import { NODE_HOST_STATS_EVENT, NODE_HOST_STATS_INTERVAL_MS } from "../shared/node-host-stats.js";
import { startNodeHostConnection } from "./connection.js";
import * as hostStats from "./host-stats.js";

const stats = { cpuCount: 8, memoryTotalBytes: 100, memoryFreeBytes: 50 };
const gateway = { url: "wss://gateway.example.test", protocol: 4, capabilities: [] };

it.each([
  {
    declared: undefined,
    expected: [
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
      "browser",
      "computer",
      "skill_workshop",
      "sessions_spawn",
      "sessions_send",
      "portal",
    ],
  },
  {
    declared: ["presence", "future_tool", "portal", "read"],
    expected: ["presence", "future_tool", "portal", "read"],
  },
  { declared: ["future_tool"], expected: ["future_tool"] },
  { declared: [], expected: [] },
])(
  "preserves declared launch names or the published 2026.9.6 vocabulary ($declared)",
  ({ declared, expected }) => {
    const declaration = parseNodeRunnerInventoryDeclaration({
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: {
        enabled: true,
        capacity: { total: 2, available: 2 },
        environmentSession: 1,
        capturedExecPolicy: true,
        ...(declared
          ? {
              bundlePrewarm: 1,
              bundleRetention: 1,
              bundleStatus: 1,
              portalStream: 1,
              preparedWorkspace: 1,
              launchToolNames: declared,
            }
          : {}),
      },
    });
    if (!declaration || !("workerHost" in declaration)) {
      throw new Error("Expected the supervisor declaration to parse");
    }
    const names = resolveNodeWorkerLaunchToolNames(declaration.workerHost);
    expect(names).toEqual(expected);
    if (declared) {
      expect(declaration.workerHost).toMatchObject({ launchToolNames: expected });
    } else {
      expect(names).not.toContain("presence");
      expect(resolveNodeWorkerLaunchToolNames(undefined)).toEqual(names);
      expect(resolveNodeWorkerLaunchToolNames({ enabled: false })).toEqual(names);
    }
  },
);

it.each([
  { reason: "non-array", value: "read" },
  { reason: "duplicate", value: ["read", "read"] },
  { reason: "duplicate unknown", value: ["future_tool", "future_tool"] },
  { reason: "non-string", value: [1] },
  { reason: "empty name", value: [""] },
  { reason: "oversized name", value: ["x".repeat(65)] },
  { reason: "oversized array", value: Array.from({ length: 65 }, (_, index) => `tool_${index}`) },
])("rejects the whole worker declaration for $reason launch names", ({ value }) => {
  expect(
    parseNodeRunnerInventoryDeclaration({
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: { enabled: true, capacity: { total: 2, available: 2 }, launchToolNames: value },
    }),
  ).toBeNull();
});

it.each([
  { reconnectAfterFailure: false, fails: false },
  { reconnectAfterFailure: false, fails: true },
  { reconnectAfterFailure: true, fails: false },
  { reconnectAfterFailure: true, fails: true },
])(
  "joins disconnect cleanup before reconnect publication (already failed=$reconnectAfterFailure, fails=$fails)",
  async ({ reconnectAfterFailure, fails }) => {
    const { connection, request, start, runtime } = startConnectionFixture(true);
    const retirement = createDeferred();
    const retry = createDeferred();
    runtime.cancelAll.mockReturnValueOnce(retirement.promise);
    if (reconnectAfterFailure) {
      runtime.cancelAll.mockReturnValueOnce(retry.promise);
    } else if (fails) {
      runtime.cancelAll.mockRejectedValueOnce(new Error("idle retirement retry failed"));
    }
    const replacement = { request: vi.fn().mockResolvedValue({}) };
    const retired = { request: vi.fn().mockResolvedValue({}) };
    try {
      start.mock.calls[0]![0].onRunnerCapacityChanged?.({
        total: 1,
        available: 0,
        reclaimableIdle: 1,
      });
      connection.connect(gateway);
      connection.disconnect();
      if (reconnectAfterFailure) {
        const rejected = expect(retirement.promise).rejects.toThrow("idle retirement failed");
        retirement.reject(new Error("idle retirement failed"));
        await rejected;
      }
      const callsBefore = request.mock.calls.length;
      connection.connect(gateway, reconnectAfterFailure ? retired : undefined);
      connection.connect(gateway, replacement);
      if (reconnectAfterFailure) {
        await vi.advanceTimersByTimeAsync(0);
        expect(runtime.cancelAll).toHaveBeenCalledTimes(2);
        expect(retired.request).not.toHaveBeenCalled();
        expect(replacement.request).not.toHaveBeenCalled();
      }
      start.mock.calls[0]![0].onRunnerCapacityChanged?.({
        total: 1,
        available: 1,
        reclaimableIdle: 0,
      });
      expect(request).toHaveBeenCalledTimes(callsBefore);
      expect(replacement.request).not.toHaveBeenCalled();
      const pending = reconnectAfterFailure ? retry : retirement;
      if (fails) {
        pending.reject(
          new Error(
            reconnectAfterFailure ? "idle retirement retry failed" : "idle retirement failed",
          ),
        );
      } else {
        pending.resolve();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.cancelAll).toHaveBeenCalledTimes(reconnectAfterFailure || fails ? 2 : 1);
      expect(request).toHaveBeenCalledTimes(callsBefore);
      expect(retired.request).not.toHaveBeenCalled();
      if (fails) {
        expect(replacement.request).not.toHaveBeenCalled();
      } else {
        expect(replacement.request).toHaveBeenCalledWith(
          NODE_RUNNER_INVENTORY_UPDATE_METHOD,
          expect.objectContaining({
            workerHost: expect.objectContaining({ capacity: { total: 1, available: 1 } }),
          }),
        );
      }
    } finally {
      retirement.resolve();
      retry.resolve();
      await connection.close();
    }
  },
);

function startConnectionFixture(
  workerHostingEnabled = false,
  preparedWorkspacesEnabled = false,
  nativeInferenceEnabled = false,
) {
  const request = vi.fn().mockResolvedValue({ ok: true, handled: false });
  const runtime = {
    invoke: vi.fn(),
    handleInput: vi.fn(),
    cancel: vi.fn(),
    cancelAll: vi.fn<() => Promise<void>>(async () => undefined),
    tryPauseForUpdate: vi.fn(async () => true),
    resumeAfterUpdate: vi.fn(),
    updateGatewayConnection: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  type Prepared = Parameters<typeof startNodeHostConnection>[0]["prepared"];
  const start = vi.fn<Prepared["start"]>(() => runtime);
  const prepared: Prepared = {
    manifest: { commands: [], caps: [], pathEnv: "/bin" },
    workerHostingEnabled,
    preparedWorkspacesEnabled,
    nativeInferenceEnabled,
    initialInventory: { skills: [], pluginTools: [] },
    start,
  };
  const writeStderrLine = vi.fn();
  const connection = startNodeHostConnection({
    prepared,
    client: { request },
    onManifestChanged: vi.fn(),
    writeStderrLine,
  });
  const publications = () => request.mock.calls.filter(([method]) => method === "node.event");
  return { connection, request, publications, writeStderrLine, start, prepared, runtime };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(hostStats, "sampleNodeHostStats").mockReturnValue(stats);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["disconnect", "close", "manifest"] as const)(
  "publishes immediately and every minute until %s retires the connection",
  async (retire) => {
    const { connection, publications, start, prepared } = startConnectionFixture();
    try {
      expect(publications()).toEqual([]);
      connection.connect(gateway);
      expect(publications()).toEqual([
        ["node.event", { event: NODE_HOST_STATS_EVENT, payloadJSON: JSON.stringify(stats) }],
      ]);
      await vi.advanceTimersByTimeAsync(NODE_HOST_STATS_INTERVAL_MS - 1);
      expect(publications()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(publications()).toHaveLength(2);
      if (retire === "manifest") {
        start.mock.calls[0]?.[0].onManifestChanged?.(prepared.manifest);
      } else {
        await connection[retire]();
      }
      await vi.advanceTimersByTimeAsync(NODE_HOST_STATS_INTERVAL_MS * 2);
      expect(publications()).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await connection.close();
    }
  },
);

it("advertises configured native inference only to a capable Gateway", async () => {
  const { connection, request, start } = startConnectionFixture(true, false, true);
  try {
    start.mock.calls[0]?.[0].onRunnerCapacityChanged?.({ total: 1, available: 1 });
    for (const supported of [false, true, false]) {
      connection.connect({
        ...gateway,
        capabilities: supported ? [GATEWAY_SERVER_CAPS.NODE_WORKER_NATIVE_INFERENCE] : [],
      });
      await vi.advanceTimersByTimeAsync(0);
      const declaration = request.mock.calls.findLast(
        ([method]) => method === NODE_RUNNER_INVENTORY_UPDATE_METHOD,
      )?.[1];
      expect(declaration).toMatchObject({
        workerHost: {
          enabled: true,
          ...(supported ? { nativeInference: 1 } : {}),
        },
      });
      if (!supported) {
        expect(declaration.workerHost).not.toHaveProperty("nativeInference");
      }
      expect(parseNodeRunnerInventoryDeclaration(declaration)).toEqual(declaration);
    }
  } finally {
    await connection.close();
  }
});

it("logs failures once per connection, redacts secrets, and waits for the next cadence", async () => {
  const { connection, request, publications, writeStderrLine } = startConnectionFixture();
  request.mockImplementation(async (method) => {
    if (method === "node.event") {
      throw new Error("publish unavailable password=fixture-secret");
    }
    return {};
  });
  try {
    connection.connect(gateway);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeStderrLine).toHaveBeenCalledOnce();
    expect(writeStderrLine.mock.calls[0]?.[0]).toContain("node host stats publish failed:");
    expect(writeStderrLine.mock.calls[0]?.[0]).not.toContain("fixture-secret");
    await vi.advanceTimersByTimeAsync(NODE_HOST_STATS_INTERVAL_MS * 2);
    expect(publications()).toHaveLength(3);
    expect(writeStderrLine).toHaveBeenCalledOnce();
    connection.connect(gateway);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeStderrLine).toHaveBeenCalledTimes(2);
  } finally {
    await connection.close();
  }
});

it("fences late failures and sends replacement samples only through the new client", async () => {
  const { connection, request, publications, writeStderrLine } = startConnectionFixture();
  let rejectOld!: (error: Error) => void;
  request.mockImplementation((method) =>
    method === "node.event"
      ? new Promise((_resolve, reject) => {
          rejectOld = reject;
        })
      : Promise.resolve({}),
  );
  const replacementRequest = vi.fn().mockResolvedValue({});
  try {
    connection.connect(gateway);
    connection.connect(gateway, { request: replacementRequest });
    rejectOld(new Error("retired request failed"));
    await vi.advanceTimersByTimeAsync(NODE_HOST_STATS_INTERVAL_MS);
    expect(writeStderrLine).not.toHaveBeenCalled();
    expect(publications()).toHaveLength(1);
    expect(
      replacementRequest.mock.calls.filter(([method]) => method === "node.event"),
    ).toHaveLength(2);
  } finally {
    await connection.close();
  }
});

it("logs runner publication failure changes while continuing retries through recovery", async () => {
  const { connection, request, start, writeStderrLine } = startConnectionFixture(true);
  const approvalMessage = "runner capability surface is awaiting operator approval";
  let failure: string | undefined = approvalMessage;
  request.mockImplementation(async (method) => {
    if (method === NODE_RUNNER_INVENTORY_UPDATE_METHOD && failure) {
      throw new GatewayClientRequestError({ code: "UNAVAILABLE", message: failure });
    }
    return {};
  });
  const publications = () =>
    request.mock.calls.filter(([method]) => method === NODE_RUNNER_INVENTORY_UPDATE_METHOD);
  const capacityChanged = start.mock.calls[0]![0].onRunnerCapacityChanged!;
  try {
    capacityChanged({ total: 2, available: 2 });
    connection.connect(gateway);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeStderrLine).toHaveBeenCalledExactlyOnceWith(
      `node host runner inventory publish failed: GatewayClientRequestError: ${approvalMessage}`,
    );
    for (const delay of [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]) {
      const before = publications().length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(publications()).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(publications()).toHaveLength(before + 1);
      expect(writeStderrLine).toHaveBeenCalledOnce();
    }

    failure = "Gateway unavailable";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeStderrLine).toHaveBeenCalledTimes(2);
    expect(writeStderrLine).toHaveBeenLastCalledWith(
      "node host runner inventory publish failed: GatewayClientRequestError: Gateway unavailable",
    );

    failure = undefined;
    await vi.advanceTimersByTimeAsync(5_000);
    const recoveredPublications = publications().length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publications()).toHaveLength(recoveredPublications);

    failure = "Gateway unavailable";
    capacityChanged({ total: 2, available: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(writeStderrLine).toHaveBeenCalledTimes(3);

    connection.disconnect();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeStderrLine).toHaveBeenCalledTimes(3);
    connection.connect(gateway);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeStderrLine).toHaveBeenCalledTimes(4);
  } finally {
    await connection.close();
  }
});

it.each([false, true])(
  "refreshes acknowledged runner facts without changing hosting consent: %s",
  async (enabled) => {
    const { connection, request, start } = startConnectionFixture(enabled);
    try {
      start.mock.calls[0]?.[0].onRunnerCapacityChanged?.({ total: 1, available: 0 });
      connection.connect(gateway);
      await vi.advanceTimersByTimeAsync(0);
      const callsBefore = request.mock.calls.length;
      const timersBefore = vi.getTimerCount();
      connection.refreshRunnerInventory();
      await vi.advanceTimersByTimeAsync(0);
      expect(request.mock.calls.slice(callsBefore)).toEqual([
        [
          NODE_RUNNER_INVENTORY_UPDATE_METHOD,
          expect.objectContaining({
            workerHost: enabled
              ? expect.objectContaining({ enabled: true, capacity: { total: 1, available: 0 } })
              : { enabled: false },
          }),
        ],
      ]);
      expect(vi.getTimerCount()).toBe(timersBefore);
      connection.disconnect();
      connection.refreshRunnerInventory();
      expect(request).toHaveBeenCalledTimes(callsBefore + 1);
    } finally {
      await connection.close();
    }
  },
);

it.each(["resolve", "reject"] as const)(
  "retires in-flight runner publication and its pending value before late %s",
  async (settle) => {
    const { connection, request, start, writeStderrLine } = startConnectionFixture(true);
    const previous = createDeferred<unknown>();
    let first = true;
    request.mockImplementation((method) => {
      if (method === NODE_RUNNER_INVENTORY_UPDATE_METHOD && first) {
        first = false;
        return previous.promise;
      }
      return Promise.resolve({});
    });
    const capacityChanged = start.mock.calls[0]![0].onRunnerCapacityChanged!;
    const publications = () =>
      request.mock.calls.filter(([method]) => method === NODE_RUNNER_INVENTORY_UPDATE_METHOD);
    try {
      capacityChanged({ total: 2, available: 2 });
      connection.connect(gateway);
      capacityChanged({ total: 2, available: 1 });
      expect(publications()).toHaveLength(1);
      connection.refreshRunnerInventory();
      await vi.advanceTimersByTimeAsync(0);
      capacityChanged({ total: 2, available: 0 });
      await vi.advanceTimersByTimeAsync(0);
      if (settle === "resolve") {
        previous.resolve({});
      } else {
        previous.reject(new Error("retired publication rejected"));
      }
      await vi.advanceTimersByTimeAsync(5_000);
      expect(publications().map(([, params]) => params)).toEqual(
        [2, 1, 0].map((available) =>
          expect.objectContaining({
            workerHost: expect.objectContaining({ capacity: { total: 2, available } }),
          }),
        ),
      );
      expect(writeStderrLine).not.toHaveBeenCalled();
    } finally {
      previous.resolve({});
      await connection.close();
    }
  },
);

it("keeps refreshed publication on its replacement connection despite an old acknowledgment", async () => {
  const { connection, request, start } = startConnectionFixture(true);
  const previous = createDeferred<unknown>();
  request.mockImplementation((method) =>
    method === NODE_RUNNER_INVENTORY_UPDATE_METHOD ? previous.promise : Promise.resolve({}),
  );
  const replacementRequest = vi.fn().mockResolvedValue({});
  try {
    start.mock.calls[0]![0].onRunnerCapacityChanged?.({ total: 1, available: 1 });
    connection.connect(gateway);
    connection.refreshRunnerInventory();
    connection.connect(gateway, { request: replacementRequest });
    await vi.advanceTimersByTimeAsync(0);
    connection.refreshRunnerInventory();
    previous.resolve({});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      request.mock.calls.filter(([method]) => method === NODE_RUNNER_INVENTORY_UPDATE_METHOD),
    ).toHaveLength(2);
    expect(
      replacementRequest.mock.calls.filter(
        ([method]) => method === NODE_RUNNER_INVENTORY_UPDATE_METHOD,
      ),
    ).toHaveLength(2);
  } finally {
    previous.resolve({});
    await connection.close();
  }
});

it.each([false, true])(
  "advertises prepared workspace registration only when enabled: %s",
  async (enabled) => {
    const { connection, request, start } = startConnectionFixture(true, enabled);
    try {
      start.mock.calls[0]?.[0].onRunnerCapacityChanged?.({ total: 1, available: 1 });
      connection.connect(gateway);
      const declaration = request.mock.calls.find(
        ([method]) => method === NODE_RUNNER_INVENTORY_UPDATE_METHOD,
      )?.[1];
      expect(declaration).toMatchObject({ workerHost: { enabled: true } });
      const parsed = parseNodeRunnerInventoryDeclaration(declaration);
      expect(parsed).toEqual(declaration);
      if (!parsed || !("workerHost" in parsed) || !parsed.workerHost.enabled) {
        throw new Error("Expected an enabled worker declaration");
      }
      expect(parsed.workerHost.preparedWorkspace).toBe(enabled ? 1 : undefined);
      start.mock.calls[0]?.[0].onWorkerHostingDisabled?.("test revoked worker consent");
      await vi.advanceTimersByTimeAsync(0);
      expect(
        request.mock.calls.findLast(
          ([method]) => method === NODE_RUNNER_INVENTORY_UPDATE_METHOD,
        )?.[1],
      ).toMatchObject({ workerHost: { enabled: false } });
    } finally {
      await connection.close();
    }
  },
);

const disabledReason =
  "State directory /srv/node-state is group-writable; run chmod go-w /srv/node-state";

it.each([
  { kind: "optional", platform: "linux", bun: false },
  { kind: "idle", platform: "linux", bun: false },
  { kind: "disabled", platform: "linux", bun: false },
  { kind: "workspace", platform: "linux", bun: false },
  { kind: "workspace", platform: "linux", bun: true },
  { kind: "workspace", platform: "win32", bun: false },
  { kind: "workspace", platform: "win32", bun: true },
  { kind: "workspace", platform: "darwin", bun: false },
] as const)(
  "negotiates $kind inventory per connection ($platform, Bun=$bun)",
  async ({ kind, platform, bun }) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    Object.defineProperty(process.versions, "bun", {
      configurable: true,
      value: bun ? "fixture" : undefined,
    });
    const { connection, request, start, prepared } = startConnectionFixture(true);
    const capacity =
      kind === "idle"
        ? { total: 2, available: 0, reclaimableIdle: 2 }
        : kind === "workspace"
          ? { total: 1, available: 1 }
          : { total: 2, available: 2 };
    const capabilities = {
      optional: [
        GATEWAY_SERVER_CAPS.NODE_WORKER_CAPTURED_EXEC_POLICY,
        GATEWAY_SERVER_CAPS.NODE_WORKER_LAUNCH_TOOL_NAMES,
        GATEWAY_SERVER_CAPS.NODE_WORKER_STATUS_WAIT,
      ],
      idle: [GATEWAY_SERVER_CAPS.NODE_WORKER_IDLE_RETENTION],
      disabled: [GATEWAY_SERVER_CAPS.NODE_WORKER_HOST_DIAGNOSTICS],
      workspace: [
        GATEWAY_SERVER_CAPS.NODE_WORKER_WORKSPACE_QUIESCENCE,
        GATEWAY_SERVER_CAPS.NODE_WORKER_STATUS_WAIT,
        GATEWAY_SERVER_CAPS.NODE_WORKER_LAUNCH_TOOL_NAMES,
      ],
    };
    try {
      if (kind === "disabled") {
        start.mock.calls[0]![0].onWorkerHostingDisabled?.(disabledReason);
      } else {
        start.mock.calls[0]![0].onRunnerCapacityChanged?.(capacity);
      }
      for (const supported of [false, true, false]) {
        connection.connect({ ...gateway, capabilities: supported ? capabilities[kind] : [] });
        await vi.advanceTimersByTimeAsync(0);
        const declaration = request.mock.calls.findLast(
          ([method]) => method === NODE_RUNNER_INVENTORY_UPDATE_METHOD,
        )?.[1];
        expect(declaration).toEqual({
          protocolFeatures: ["node-worker-supervisor-v6"],
          workerHost:
            kind === "disabled"
              ? { enabled: false, ...(supported ? { reason: disabledReason } : {}) }
              : {
                  enabled: true,
                  capacity: {
                    total: capacity.total,
                    available: capacity.available,
                    ...(supported && kind === "idle" ? { reclaimableIdle: 2 } : {}),
                  },
                  bundlePrewarm: 1,
                  ...(supported && kind === "idle" ? { idleRetention: true } : {}),
                  ...(supported && kind === "optional" ? { capturedExecPolicy: true } : {}),
                  ...(supported && (kind === "optional" || kind === "workspace")
                    ? {
                        statusWait: 1,
                        launchToolNames:
                          kind === "optional"
                            ? expect.arrayContaining([
                                "read",
                                "sessions_spawn",
                                "sessions_send",
                                "skill_workshop",
                                "portal",
                                "presence",
                              ])
                            : [...CORE_WORKER_LAUNCH_TOOL_NAMES],
                      }
                    : {}),
                  ...(supported &&
                  kind === "workspace" &&
                  (platform === "linux" || platform === "win32") &&
                  !bun
                    ? { workspaceQuiescence: 1 }
                    : {}),
                },
        });
        expect(parseNodeRunnerInventoryDeclaration(declaration)).toEqual(declaration);
        expect(prepared.manifest).toEqual({ commands: [], caps: [], pathEnv: "/bin" });
      }
    } finally {
      await connection.close();
      Object.defineProperty(process, "platform", descriptor);
      if (bunDescriptor) {
        Object.defineProperty(process.versions, "bun", bunDescriptor);
      } else {
        delete process.versions.bun;
      }
    }
  },
);
