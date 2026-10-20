import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as pluginRuntime from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import * as workerStore from "../state/openclaw-state-worker-store.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { useMockHttp } from "../test-utils/mock-http.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import {
  buildTelemetryPayload,
  checkTelemetryUpdate,
  resolveTelemetryStatus,
} from "./telemetry.js";
import { blockTelemetryPersistence } from "./telemetry.test-support.js";

const NOW = Date.parse("2026-08-23T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const TELEMETRY_URL = "https://telemetry.openclaw.ai/api/latest-version";
const TELEMETRY_STATE_KEY = "telemetry.updateCheck";
const mockHttp = useMockHttp();
const update = { version: "2026.8.24" };

function respond(version = update.version, url = TELEMETRY_URL) {
  mockHttp.intercept({ url, reply: { json: { version } } });
}

function readState() {
  return readConfigMachineState(TELEMETRY_STATE_KEY);
}

function payloadFor(config: OpenClawConfig = {}, surface: "gateway" | "cli" = "gateway") {
  return buildTelemetryPayload(config, { surface });
}

function checkUpdate(config: OpenClawConfig = {}, nowMs = NOW, fetchImpl?: typeof fetch) {
  vi.spyOn(Date, "now").mockReturnValue(nowMs);
  if (fetchImpl) {
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
  }
  return checkTelemetryUpdate(() => config);
}

function providerConfig(baseUrl: string, apiKey?: string) {
  return {
    baseUrl: `https://${baseUrl}.example.invalid/v1`,
    ...(apiKey ? { apiKey } : {}),
    models: [],
  };
}

function installPluginRegistry(...plugins: Parameters<typeof createPluginRecord>[0][]): void {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(...plugins.map((plugin) => createPluginRecord(plugin)));
  pluginRuntime.setActivePluginRegistry(registry);
}

function createFeatureConfig(enabled = true): OpenClawConfig {
  return {
    telemetry: { enabled },
    auth: {
      profiles: {
        "anthropic:private-account": {
          provider: "anthropic",
          mode: "api_key",
          email: "private@example.invalid",
        },
      },
    },
    channels: {
      telegram: { enabled: true, botToken: "private-telegram-token" },
      discord: { enabled: true, token: "private-discord-token" },
      "acme-internal-crm": { enabled: true },
      slack: { enabled: false, botToken: "private-slack-token" },
      defaults: { groupPolicy: "allowlist" },
      modelByChannel: { telegram: { "private-account-id": "openai/private-model" } },
    },
    models: {
      providers: {
        openai: providerConfig("private-provider", "private-provider-api-key"),
        anthropic: providerConfig("private-anthropic", "private-anthropic-api-key"),
        "acme-llm": providerConfig("private-llm"),
      },
    },
    plugins: {
      entries: {
        telegram: { enabled: true },
        discord: { enabled: true },
        memory: { enabled: true },
        "acme-internal-crm": { enabled: true },
        "acme-internal-workflows": { enabled: true },
        disabled: { enabled: false },
      },
    },
    gateway: { auth: { mode: "token", token: "private-gateway-token" } },
  };
}

describe("anonymous telemetry", () => {
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-telemetry-",
      env: {
        CI: undefined,
        DO_NOT_TRACK: undefined,
        OPENCLAW_NIX_MODE: undefined,
        OPENCLAW_NO_AUTO_UPDATE: undefined,
        OPENCLAW_TELEMETRY_ENDPOINT: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
      },
    });
    installPluginRegistry(
      { id: "telegram", origin: "bundled", channelIds: ["telegram"] },
      { id: "discord", origin: "bundled", channelIds: ["discord"] },
      { id: "memory", origin: "bundled" },
      { id: "acme-internal-crm", channelIds: ["acme-internal-crm"] },
      { id: "acme-internal-workflows" },
      { id: "disabled", origin: "bundled", enabled: false, status: "disabled" },
      { id: "load-error", origin: "bundled", status: "error" },
      { id: "deferred", origin: "bundled", imported: false },
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    await testState.cleanup();
  });

  it("builds deterministic feature facts without credentials, identities, paths, or hostnames", async () => {
    const payload = await payloadFor(createFeatureConfig());
    const serialized = JSON.stringify(payload);

    expect(payload).toEqual({
      schema: 1,
      version: expect.any(String),
      platform: `${process.platform}-${process.arch}`,
      node: process.versions.node,
      surface: "gateway",
      features: {
        channels: ["discord", "telegram"],
        providerFamilies: ["anthropic", "openai"],
        plugins: ["discord", "memory", "telegram"],
        pluginsEnabled: 5,
        sessionsLast24h: expect.any(Number),
      },
    });
    expect(serialized).not.toMatch(
      /"(?:id|accountId|userId|machineId|installId|token|apiKey|secret|password|prompt|message|host|hostname|baseUrl|path|email|models)"\s*:/iu,
    );
    expect(serialized).not.toContain("private-");
    expect(serialized).not.toContain("acme-internal-crm");
    expect(serialized).not.toContain("acme-internal-workflows");
    expect(serialized).not.toContain("acme-llm");
    expect(serialized).not.toContain("example.invalid");
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain(testState.stateDir);
    expect(payload.features.sessionsLast24h).toBeGreaterThanOrEqual(0);
  });

  it("counts loaded default plugins instead of unloaded config entries and accepts official provider families", async () => {
    installPluginRegistry(
      { id: "whatsapp", origin: "bundled", channelIds: ["whatsapp"] },
      { id: "diagnostics-otel", origin: "bundled" },
    );
    const payload = await payloadFor({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/private-model",
            fallbacks: ["openai/private-fallback", "cohere/private-official-model"],
          },
        },
        entries: {
          researcher: { model: "google/private-research-model" },
        },
      },
      channels: { whatsapp: { allowFrom: ["+15555550123"] } },
      plugins: { entries: { "never-loaded": { enabled: true } } },
    });

    expect(payload.features).toMatchObject({
      channels: ["whatsapp"],
      providerFamilies: ["anthropic", "cohere", "google", "openai"],
      plugins: ["diagnostics-otel", "whatsapp"],
      pluginsEnabled: 2,
    });
    expect(JSON.stringify(payload)).not.toContain("private-");
    expect(JSON.stringify(payload)).not.toContain("+15555550123");
  });

  it("classifies configured channels by their loaded plugin owner", async () => {
    installPluginRegistry(
      { id: "public-channel-owner", origin: "bundled", channelIds: ["public-alias"] },
      { id: "acme-internal-crm", channelIds: ["telegram"] },
    );

    const payload = await payloadFor({
      channels: { "public-alias": { enabled: true }, telegram: { enabled: true } },
    });

    expect(payload.features).toMatchObject({
      channels: ["public-alias"],
      plugins: ["public-channel-owner"],
      pluginsEnabled: 2,
    });
    expect(JSON.stringify(payload)).not.toContain("acme-internal-crm");
  });

  it.each([
    { provider: " OpenAI ", expected: ["openai"] },
    { provider: " Open AI ", expected: [] },
  ])("reports loaded provider $provider as $expected", async ({ provider, expected }) => {
    await testState.writeConfig({
      plugins: { enabled: false },
      models: {
        providers: { [provider]: { baseUrl: "https://provider.example.invalid/v1", models: [] } },
      },
    });
    const config = createConfigIO({
      configPath: testState.configPath,
      env: { OPENCLAW_STATE_DIR: testState.stateDir },
      homedir: () => testState.home,
      observe: false,
    }).loadConfig();

    // The loader accepts these spellings without canonicalizing the provider identity.
    expect(Object.keys(config.models?.providers ?? {})).toEqual([provider]);
    expect((await payloadFor(config)).features.providerFamilies).toEqual(expected);
  });

  it("uses manifest-owned plugin activation when a CLI has no active runtime registry", async () => {
    vi.spyOn(pluginRuntime, "getActivePluginRegistry").mockReturnValue(null);
    const payload = await payloadFor(
      {
        channels: { telegram: { enabled: true } },
        plugins: { allow: ["telegram"] },
      },
      "cli",
    );

    expect(payload.features.channels).toEqual(["telegram"]);
    expect(payload.features.plugins).toContain("telegram");
    expect(payload.features.pluginsEnabled).toBe(payload.features.plugins.length);
  });

  it("counts only session creation events from the previous 24 hours", async () => {
    const { recordSessionStateEventAsync } = await import("../sessions/session-state-events.js");
    const now = Date.now();
    for (const event of [
      { sessionKey: "recent", kind: "created" as const, occurredAt: now - 1000 },
      { sessionKey: "older", kind: "created" as const, occurredAt: now - DAY_MS - 1000 },
      { sessionKey: "other", kind: "run_completed" as const, occurredAt: now - 1000 },
    ]) {
      await recordSessionStateEventAsync(
        {
          ...event,
          agentId: "main",
          actorType: "system",
          summary: "test session event",
        },
        { now: event.occurredAt },
      );
    }

    expect((await payloadFor({})).features.sessionsLast24h).toBe(1);
  });

  it("retains a successful response through write failures and recovers without extending its throttle", async () => {
    const unblock = blockTelemetryPersistence();
    const announced = { ...update, note: "A newer release is available." };
    mockHttp.intercept({ url: TELEMETRY_URL, reply: { json: announced } });
    respond("2026.8.25");
    const first = await checkUpdate();
    const retained = await checkUpdate({}, NOW + 120_000);

    expect({ first, retained, requests: mockHttp.requests().length }).toEqual({
      first: announced,
      retained: announced,
      requests: 1,
    });
    expect(readState()).toBeUndefined();

    unblock();
    await expect(checkUpdate({}, NOW + 240_000)).resolves.toEqual(announced);
    expect(readState()).toEqual({
      lastPingAt: NOW,
      latestVersion: announced.version,
      note: announced.note,
    });
    await expect(checkUpdate({}, NOW + DAY_MS - 1)).resolves.toEqual(announced);
    expect(mockHttp.requests()).toHaveLength(1);

    await expect(checkUpdate({}, NOW + DAY_MS)).resolves.toEqual({
      version: "2026.8.25",
    });
    expect(mockHttp.requests()).toHaveLength(2);
    expect(readState()).toEqual({
      lastPingAt: NOW + DAY_MS,
      latestVersion: "2026.8.25",
    });
  });

  it.each(["endpoint", "state directory"] as const)(
    "keeps an unpersisted response isolated when the %s changes",
    async (scope) => {
      blockTelemetryPersistence();
      respond();
      await checkUpdate();

      let endpoint = TELEMETRY_URL;
      if (scope === "endpoint") {
        endpoint = "https://telemetry.example.invalid/api/latest-version";
        setTestEnvValue("OPENCLAW_TELEMETRY_ENDPOINT", endpoint);
      } else {
        setTestEnvValue("OPENCLAW_STATE_DIR", testState.path("alternate-state"));
      }
      respond("2026.8.25", endpoint);

      await expect(checkUpdate({}, NOW + 120_000)).resolves.toEqual({ version: "2026.8.25" });
      expect(mockHttp.requests()).toHaveLength(2);
      testState.applyEnv();

      await expect(checkUpdate({}, NOW + 240_000)).resolves.toEqual(update);
      expect(mockHttp.requests()).toHaveLength(2);
    },
  );

  it("keeps the request's state destination when the environment changes during HTTP", async () => {
    const unblock = blockTelemetryPersistence();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      setTestEnvValue("OPENCLAW_STATE_DIR", testState.path("alternate-state"));
      return Response.json(update);
    });
    await expect(checkUpdate({}, NOW, fetchImpl)).resolves.toEqual(update);
    expect(readState()).toBeUndefined();
    testState.applyEnv();
    unblock();

    await expect(checkUpdate({}, NOW + 120_000, fetchImpl)).resolves.toEqual(update);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readState()).toEqual({
      lastPingAt: NOW,
      latestVersion: "2026.8.24",
    });
  });

  it("does not replace a newer persisted success with a retained older response", async () => {
    const unblock = blockTelemetryPersistence();
    respond();
    await checkUpdate();
    unblock();
    const newerState = { lastPingAt: NOW + 60_000, latestVersion: "2026.8.25" };
    writeConfigMachineState(TELEMETRY_STATE_KEY, newerState);

    await expect(checkUpdate({}, NOW + 120_000)).resolves.toEqual({
      version: "2026.8.25",
    });
    expect(readState()).toEqual(newerState);
    expect(mockHttp.requests()).toHaveLength(1);
  });

  it("preserves a newer durable success written while the request was awaiting HTTP", async () => {
    const newerState = { lastPingAt: NOW + 60_000, latestVersion: "2026.8.25" };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      writeConfigMachineState(TELEMETRY_STATE_KEY, newerState);
      return Response.json(update);
    });

    await expect(checkUpdate({}, NOW, fetchImpl)).resolves.toEqual({
      version: newerState.latestVersion,
    });

    expect(readState()).toEqual(newerState);
  });

  it("uses a newer transaction-selected success instead of sending at the pending timestamp's expiry", async () => {
    const unblock = blockTelemetryPersistence();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(update))
      .mockResolvedValueOnce(Response.json({ version: "2026.8.26" }));
    await checkUpdate({}, NOW, fetchImpl);
    unblock();

    const newerState = { lastPingAt: NOW + DAY_MS - 60_000, latestVersion: "2026.8.25" };
    const originalRead = workerStore.runOpenClawStateWorkerOperation;
    vi.spyOn(workerStore, "runOpenClawStateWorkerOperation").mockImplementationOnce(
      async (...args) => {
        const snapshot = await originalRead(...args);
        writeConfigMachineState(TELEMETRY_STATE_KEY, newerState);
        return snapshot;
      },
    );
    const result = await checkUpdate({}, NOW + DAY_MS, fetchImpl);
    expect({ result, requests: fetchImpl.mock.calls.length }).toEqual({
      result: { version: newerState.latestVersion },
      requests: 1,
    });
    expect(readState()).toEqual(newerState);
  });

  it("sends only an anonymous GET when explicitly opted out", async () => {
    const config = createFeatureConfig(false);
    mockHttp.intercept({
      url: TELEMETRY_URL,
      method: "GET",
      requestHeaders: {
        "user-agent": `openclaw/${VERSION} (${process.platform}; node/${process.versions.node}; ${process.arch}; gateway)`,
      },
      reply: { json: update },
    });

    await expect(checkUpdate(config)).resolves.toEqual(update);

    expect(mockHttp.requests()).toHaveLength(1);
  });

  it("POSTs exactly the canonical payload only after explicit feature-stats opt-in", async () => {
    const config = createFeatureConfig();
    const expectedBody = JSON.stringify(await payloadFor(config));
    mockHttp.intercept({
      url: TELEMETRY_URL,
      method: "POST",
      requestBody: expectedBody,
      requestHeaders: { "content-type": /^application\/json(?:\s*;.*)?$/u },
      reply: { json: update },
    });

    await expect(checkUpdate(config)).resolves.toEqual(update);

    expect(mockHttp.requests()).toHaveLength(1);
  });

  it("DO_NOT_TRACK=true suppresses feature stats but keeps update checks", async () => {
    setTestEnvValue("DO_NOT_TRACK", "true");
    mockHttp.intercept({
      url: TELEMETRY_URL,
      method: "GET",
      reply: { json: update },
    });

    await expect(checkUpdate(createFeatureConfig())).resolves.toEqual(update);

    expect(mockHttp.requests()).toHaveLength(1);
  });

  it.each([
    ["OPENCLAW_NO_AUTO_UPDATE", "1"],
    ["CI", "true"],
    ["OPENCLAW_NIX_MODE", "1"],
  ])("never sends a request when %s=%s", async (key, value) => {
    setTestEnvValue(key, value);
    await expect(checkUpdate(createFeatureConfig())).resolves.toBeNull();
    expect(mockHttp.requests()).toHaveLength(0);
    expect(readState()).toBeUndefined();
    if (key === "CI") {
      expect((await resolveTelemetryStatus(createFeatureConfig())).reason).toBe(
        "automated-environment",
      );
    }
  });

  it("still reports from an automated environment when an endpoint is configured for it", async () => {
    const customEndpoint = "https://telemetry.example.invalid/api/latest-version";
    setTestEnvValue("CI", "true");
    setTestEnvValue("OPENCLAW_TELEMETRY_ENDPOINT", customEndpoint);
    respond(update.version, customEndpoint);

    await expect(checkUpdate()).resolves.toEqual(update);

    expect(mockHttp.requests()).toHaveLength(1);
  });

  it("never accesses the network in a test environment", async () => {
    setTestEnvValue("VITEST", "true");
    await expect(checkTelemetryUpdate(() => ({}))).resolves.toBeNull();

    expect(mockHttp.requests()).toHaveLength(0);
  });

  it.each([
    { name: "HTTP errors", reply: { status: 503, json: update } },
    { name: "a missing version", reply: { json: { note: "Missing required version" } } },
  ])("fails silently on $name without stamping a successful ping", async ({ reply }) => {
    mockHttp.intercept({ url: TELEMETRY_URL, reply });

    await expect(checkUpdate()).resolves.toBeNull();

    expect(mockHttp.requests()).toHaveLength(1);
    expect(readState()).toBeUndefined();
    respond();
    await expect(checkUpdate({}, NOW + 120_000)).resolves.toEqual(update);
    expect(mockHttp.requests()).toHaveLength(2);
  });

  it("bounds untrusted remote update notes before display or persistence", async () => {
    mockHttp.intercept({
      url: TELEMETRY_URL,
      reply: { json: { version: "2026.8.24", note: "x".repeat(800) } },
    });

    const result = await checkUpdate();
    const persisted = readConfigMachineState<{ note?: string }>(TELEMETRY_STATE_KEY);

    expect(result?.note).toHaveLength(500);
    expect(persisted?.note).toHaveLength(500);
  });

  it("bounds streamed update responses without replacing the cached result or successful ping", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(120);
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('{"version":"2026.8.25","padding":"'),
      ...Array<Uint8Array>(32).fill(chunk),
      encoder.encode('"}'),
    ][Symbol.iterator]();
    let canceled = false;
    let enqueuedBytes = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.next();
        if (next.done) {
          controller.close();
        } else {
          enqueuedBytes += next.value.byteLength;
          controller.enqueue(next.value);
        }
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ version: "2026.8.24", padding: "x".repeat(chunk.length) }),
      )
      .mockResolvedValueOnce(new Response(body));
    await expect(checkUpdate({}, NOW, fetchImpl)).resolves.toEqual(update);
    await expect(checkUpdate({}, NOW + DAY_MS + 1, fetchImpl)).resolves.toEqual(update);
    expect(canceled).toBe(true);
    expect(enqueuedBytes).toBeLessThan(32 * chunk.length);
    expect(readState()).toEqual({
      lastPingAt: NOW,
      latestVersion: "2026.8.24",
    });
    await expect(checkUpdate({}, NOW + DAY_MS + 30_001, fetchImpl)).resolves.toEqual(update);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
