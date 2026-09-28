import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import * as workerContext from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";
import type { TelemetryWorkerOperations, TelemetryState } from "./telemetry-worker-contract.js";
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
vi.mock("../plugins/plugin-runtime-inventory.js", () => ({ listEnabledPluginRecords: () => [] }));

let sequence = 0;
let testState: OpenClawTestState;
beforeEach(async () => {
  testState = await createOpenClawTestState({ layout: "state-only", prefix: "telemetry-async-" });
  contexts.length = 0;
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
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeOpenClawStateDatabaseAsync();
  await testState.cleanup();
});

it("retains best-effort reads and accepted updates when storage cannot admit work", async () => {
  vi.spyOn(workerContext, "captureOpenClawStateWorkerContext").mockImplementation(() => {
    throw new Error("Storage admission is closed");
  });
  const config = { telemetry: { enabled: true } };
  expect(
    (await buildTelemetryPayload(config, { surface: "gateway" })).features.sessionsLast24h,
  ).toBe(0);
  expect(await resolveTelemetryStatus(config)).toMatchObject({ enabled: true, reason: "enabled" });
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ version: "2026.8.24" }));
  const options = { surface: "gateway" as const, fetchImpl, nowMs: 100 };
  expect(await checkTelemetryUpdate(() => config, options)).toEqual({ version: "2026.8.24" });
  expect(await checkTelemetryUpdate(() => config, { ...options, nowMs: 200 })).toEqual({
    version: "2026.8.24",
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
});

it("coalesces a cold check through storage preparation and accepted response persistence", async () => {
  const read = createDeferredCore<TelemetryState>();
  const persisted = createDeferredCore<TelemetryState>();
  const persistenceRequested = createDeferredCore();
  execute.mockImplementation(async (command) => {
    if (command.type === "telemetry.readState") {
      return await read.promise;
    }
    if (command.type === "telemetry.persistSuccess") {
      persistenceRequested.resolve();
      return await persisted.promise;
    }
    return 3;
  });
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ version: "2026.8.24" }));
  const options = { surface: "gateway" as const, fetchImpl, nowMs: 100 };
  let settled = false;
  const first = checkTelemetryUpdate(() => ({}), options).then((value) => {
    settled = true;
    return value;
  });
  const second = checkTelemetryUpdate(() => ({}), options);
  try {
    expect(fetchImpl).not.toHaveBeenCalled();
    read.resolve({});
    await persistenceRequested.promise;
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
  } finally {
    read.resolve({});
    persisted.resolve({ lastPingAt: 101, latestVersion: "2026.8.25" });
    await Promise.all([first, second]);
  }
  expect(await first).toEqual({ version: "2026.8.25" });
  expect(await second).toEqual(await first);
  expect(
    execute.mock.calls.filter(([command]) => command.type === "telemetry.persistSuccess"),
  ).toHaveLength(1);
});

it("returns another path's fresh cache before joining a pending network check", async () => {
  const response = createDeferredCore<Response>();
  const requested = createDeferredCore();
  let reads = 0;
  execute.mockImplementation(async (command) => {
    if (command.type === "telemetry.readState") {
      return ++reads === 2 ? { lastPingAt: 100, latestVersion: "2026.8.25" } : {};
    }
    return command.type === "telemetry.persistSuccess" ? command.input.state : 0;
  });
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    requested.resolve();
    return await response.promise;
  });
  const options = { surface: "gateway" as const, fetchImpl, nowMs: 100 };
  const first = checkTelemetryUpdate(() => ({}), options);
  await requested.promise;
  vi.stubEnv("OPENCLAW_STATE_DIR", testState.path("cached-state"));
  vi.stubEnv("OPENCLAW_TELEMETRY_ENDPOINT", "https://telemetry.example.invalid/cached");
  let cachedVersion: string | undefined;
  const second = checkTelemetryUpdate(() => ({}), options).then((update) => {
    cachedVersion = update?.version;
    return update;
  });
  let third: ReturnType<typeof checkTelemetryUpdate> | undefined;
  try {
    await vi.waitFor(() => expect(cachedVersion).toBe("2026.8.25"));
    expect(fetchImpl).toHaveBeenCalledOnce();
    vi.stubEnv("OPENCLAW_STATE_DIR", testState.path("third-state"));
    third = checkTelemetryUpdate(() => ({}), options);
  } finally {
    response.resolve(Response.json({ version: "2026.8.24" }));
    await Promise.all([first, second, third]);
  }
  expect(await first).toEqual({ version: "2026.8.24" });
  expect(await second).toEqual({ version: "2026.8.25" });
  expect(await third).toEqual(await first);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it("joins the captured check when it settles during another caller's storage wait", async () => {
  const delayedRead = createDeferredCore<TelemetryState>();
  let reads = 0;
  execute.mockImplementation(async (command) => {
    if (command.type === "telemetry.readState") {
      return ++reads === 1 ? {} : await delayedRead.promise;
    }
    return command.type === "telemetry.persistSuccess" ? command.input.state : 0;
  });
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ version: "2026.8.24" }));
  const options = { surface: "gateway" as const, fetchImpl, nowMs: 100 };
  const first = checkTelemetryUpdate(() => ({}), options);
  let secondSettled = false;
  const second = checkTelemetryUpdate(() => ({}), options).then((update) => {
    secondSettled = true;
    return update;
  });
  try {
    await first;
    await Promise.resolve();
    expect(secondSettled).toBe(false);
  } finally {
    delayedRead.resolve({});
    await Promise.all([first, second]);
  }
  expect(await second).toEqual(await first);
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(
    execute.mock.calls.filter(([command]) => command.type === "telemetry.persistSuccess"),
  ).toHaveLength(1);
});

it("does not treat another path's cached result as a network check for an uncached caller", async () => {
  const firstRead = createDeferredCore<TelemetryState>();
  let reads = 0;
  execute.mockImplementation(async (command) => {
    if (command.type === "telemetry.readState") {
      return ++reads === 1 ? await firstRead.promise : {};
    }
    return command.type === "telemetry.persistSuccess" ? command.input.state : 0;
  });
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ version: "2026.8.25" }));
  const options = { surface: "gateway" as const, fetchImpl, nowMs: 100 };
  const first = checkTelemetryUpdate(() => ({}), options);
  vi.stubEnv("OPENCLAW_STATE_DIR", testState.path("uncached-state"));
  const endpoint = "https://telemetry.example.invalid/uncached";
  vi.stubEnv("OPENCLAW_TELEMETRY_ENDPOINT", endpoint);
  const second = checkTelemetryUpdate(() => ({}), options);
  firstRead.resolve({ lastPingAt: 100, latestVersion: "2026.8.24" });
  const [cached, checked] = await Promise.all([first, second]);
  expect(cached).toEqual({ version: "2026.8.24" });
  expect(checked).toEqual({ version: "2026.8.25" });
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
    endpoint,
    expect.objectContaining({ method: "GET" }),
  );
});

it("keeps the captured endpoint and storage destination across the first read wait", async () => {
  const read = createDeferredCore<TelemetryState>();
  execute.mockImplementationOnce(() => read.promise);
  const endpoint = process.env.OPENCLAW_TELEMETRY_ENDPOINT;
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ version: "2026.8.24" }));
  const checking = checkTelemetryUpdate(() => ({ telemetry: { enabled: true } }), {
    surface: "gateway",
    fetchImpl,
  });
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

it.each(["do-not-track", "opt-out", "update-disabled", "still-enabled"] as const)(
  "honors %s when the canonical snapshot changes during the feature count",
  async (change) => {
    const count = createDeferredCore<number>();
    const countRequested = createDeferredCore();
    execute.mockImplementation(async (command) => {
      if (command.type === "telemetry.countRecentSessions") {
        countRequested.resolve();
        return await count.promise;
      }
      return command.type === "telemetry.persistSuccess" ? command.input.state : {};
    });
    const config: OpenClawConfig = { telemetry: { enabled: true } };
    setRuntimeConfigSnapshot(config);
    expect(getRuntimeConfig()).toBe(config);
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ version: "2026.8.24" }));
    const checking = checkTelemetryUpdate(getRuntimeConfig, { surface: "gateway", fetchImpl });
    try {
      await countRequested.promise;
      const replacement: OpenClawConfig = {
        telemetry: { enabled: change !== "opt-out" },
        ...(change === "update-disabled" ? { update: { checkOnStart: false } } : {}),
      };
      setRuntimeConfigSnapshot(replacement);
      expect(getRuntimeConfig()).toBe(replacement);
      expect(getRuntimeConfig()).not.toBe(config);
      expect(config.telemetry?.enabled).toBe(true);
      expect(config.update).toBeUndefined();
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
    } else if (change === "still-enabled") {
      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        expect.objectContaining({ method: "POST", body: expect.any(String) }),
      );
      const body = fetchImpl.mock.calls[0]?.[1]?.body;
      if (typeof body !== "string") {
        throw new Error("Expected the telemetry JSON request body");
      }
      expect(JSON.parse(body)).toMatchObject({ features: { sessionsLast24h: 3 } });
    } else {
      expect(fetchImpl).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "GET" }),
      );
      const request = fetchImpl.mock.calls[0]?.[1];
      expect(request).not.toHaveProperty("body");
      expect(request).not.toHaveProperty("headers.Content-Type");
    }
  },
);
