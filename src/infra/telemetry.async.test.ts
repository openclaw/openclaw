import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as pluginRuntime from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import * as workerContext from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";
import type { TelemetryWorkerOperations } from "./telemetry-store.worker.js";
import type { TelemetryState } from "./telemetry-worker-contract.js";
import {
  buildTelemetryPayload,
  checkTelemetryUpdate,
  resolveTelemetryStatus,
} from "./telemetry.js";

const { execute, contexts } = vi.hoisted(() => ({
  execute: vi.fn<(command: SqliteWorkerCommand<TelemetryWorkerOperations>) => Promise<unknown>>(),
  contexts: [] as OpenClawStateWorkerContext[],
}));

vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: (
    context: OpenClawStateWorkerContext,
    operation: (scope: { execute: typeof execute }) => Promise<unknown>,
  ) => {
    contexts.push(context);
    return operation({ execute });
  },
}));

let sequence = 0;
let testState: Awaited<ReturnType<typeof createOpenClawTestState>>;
let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
let config: OpenClawConfig;
function check(readConfig: () => OpenClawConfig = () => config, nowMs?: number) {
  vi.spyOn(Date, "now").mockReturnValue(nowMs ?? Date.now());
  return checkTelemetryUpdate(readConfig);
}
function pauseOperation<T>(type: SqliteWorkerCommand<TelemetryWorkerOperations>["type"]) {
  const result = createDeferredCore<T>();
  const requested = createDeferredCore();
  const previous = execute.getMockImplementation()!;
  execute.mockImplementation((command) => {
    if (command.type !== type) {
      return previous(command);
    }
    requested.resolve();
    return result.promise;
  });
  return { ...result, requested: requested.promise };
}
beforeEach(async () => {
  vi.spyOn(pluginRuntime, "getActivePluginRegistry").mockReturnValue(createEmptyPluginRegistry());
  config = { telemetry: { enabled: true } };
  testState = await createOpenClawTestState({ layout: "state-only", prefix: "telemetry-async-" });
  contexts.length = 0;
  fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ version: "2026.8.24" }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
  execute.mockReset().mockImplementation(async (command) => {
    switch (command.type) {
      case "telemetry.readState":
        return {};
      case "telemetry.countRecentSessions":
        return 3;
      case "telemetry.persistSuccess":
        return command.input.state;
      default:
        throw new Error("Unexpected telemetry worker operation");
    }
  });
  vi.stubEnv("OPENCLAW_TELEMETRY_ENDPOINT", `https://telemetry.example.invalid/${sequence++}`);
  vi.stubEnv("OPENCLAW_NO_AUTO_UPDATE", "");
  vi.stubEnv("OPENCLAW_NIX_MODE", "");
  vi.stubEnv("DO_NOT_TRACK", "");
  vi.stubEnv("VITEST", undefined);
  vi.stubEnv("NODE_ENV", undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeOpenClawStateDatabaseAsync();
  await testState.cleanup();
});

it("keeps reads and accepted updates when storage admission is closed", async () => {
  vi.spyOn(workerContext, "captureOpenClawStateWorkerContext").mockImplementation(() => {
    throw new Error("Storage admission is closed");
  });
  const payload = await buildTelemetryPayload(config, { surface: "gateway" });
  expect(payload.features.sessionsLast24h).toBe(0);
  expect(await resolveTelemetryStatus(config)).toMatchObject({ enabled: true, reason: "enabled" });
  expect(await check(() => config, 100)).toEqual({ version: "2026.8.24" });
  expect(await check(() => config, 200)).toEqual({ version: "2026.8.24" });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
});

it("coalesces checks through storage preparation and persistence", async () => {
  const read = pauseOperation<TelemetryState>("telemetry.readState");
  const persisted = pauseOperation<TelemetryState>("telemetry.persistSuccess");
  let settled = false;
  const first = check(() => ({}), 100).then((value) => {
    settled = true;
    return value;
  });
  const second = check(() => ({}), 100);
  try {
    expect(fetchImpl).not.toHaveBeenCalled();
    read.resolve({});
    await persisted.requested;
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
  } finally {
    read.resolve({});
    persisted.resolve({ lastPingAt: 101, latestVersion: "2026.8.25" });
    await Promise.all([first, second]);
  }
  const expected = { version: "2026.8.25" };
  expect(await Promise.all([first, second])).toEqual([expected, expected]);
  expect(
    execute.mock.calls.filter(([command]) => command.type === "telemetry.persistSuccess"),
  ).toHaveLength(1);
});

it("keeps the captured endpoint and storage destination across awaits", async () => {
  const read = pauseOperation<TelemetryState>("telemetry.readState");
  const endpoint = process.env.OPENCLAW_TELEMETRY_ENDPOINT;
  const checking = check();
  const context = contexts[0];
  try {
    vi.stubEnv("OPENCLAW_STATE_DIR", testState.path("other-state"));
    vi.stubEnv("OPENCLAW_TELEMETRY_ENDPOINT", "https://telemetry.example.invalid/changed");
  } finally {
    read.resolve({});
    await checking;
  }
  expect(contexts).toHaveLength(3);
  expect(contexts.every((candidate) => candidate === context)).toBe(true);
  expect(fetchImpl).toHaveBeenCalledWith(endpoint, expect.objectContaining({ method: "POST" }));
});

it.each(["do-not-track", "opt-out", "update-disabled"] as const)(
  "honors %s when the canonical snapshot changes during the feature count",
  async (change) => {
    const count = pauseOperation<number>("telemetry.countRecentSessions");
    setRuntimeConfigSnapshot(config);
    expect(getRuntimeConfig()).toBe(config);
    const checking = check(getRuntimeConfig);
    try {
      await count.requested;
      const replacement: OpenClawConfig = {
        telemetry: { enabled: change !== "opt-out" },
        update: { checkOnStart: change !== "update-disabled" },
      };
      setRuntimeConfigSnapshot(replacement);
      expect(getRuntimeConfig()).toBe(replacement);
      expect(getRuntimeConfig()).not.toBe(config);
      expect(config).toEqual({ telemetry: { enabled: true } });
      if (change === "do-not-track") {
        vi.stubEnv("DO_NOT_TRACK", "1");
      }
    } finally {
      count.resolve(3);
      await checking;
    }
    if (change === "update-disabled") {
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await checking).toBeNull();
    } else {
      const get = expect.objectContaining({ method: "GET" });
      expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), get);
      const request = fetchImpl.mock.calls[0]?.[1];
      expect(request).not.toHaveProperty("body");
      expect(request).not.toHaveProperty("headers.Content-Type");
    }
  },
);
