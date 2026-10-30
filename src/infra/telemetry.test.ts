import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as officialCatalog from "../plugins/official-external-plugin-catalog.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as pluginRuntime from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
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
import { sqliteWorkerOwnerProbe } from "./sqlite-worker-owner-probe.test-support.js";
import { installationCountStateKey } from "./telemetry-installation-count.js";
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

function createCountingReceiver(getDay = () => 20688) {
  return vi.fn<typeof fetch>(async (_url, init) =>
    new Headers(init?.headers).has("OpenClaw-Installation-Count")
      ? new Response(null, { status: 204 })
      : Response.json(update, { headers: { "OpenClaw-Installation-Count": "1;" + getDay() } }),
  );
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

function expectState(lastPingAt: number, latestVersion = update.version, note?: string) {
  expect(readState()).toEqual({ lastPingAt, latestVersion, ...(note ? { note } : {}) });
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

  it.each([false, true])(
    "counts a server-authorized day separately without changing the 24-hour cache (feature consent %s)",
    async (featureStats) => {
      let serverDay = 20688;
      const fetchImpl = createCountingReceiver(() => serverDay);
      const config = featureStats ? createFeatureConfig() : {};
      await expect(checkUpdate(config, NOW, fetchImpl)).resolves.toEqual(update);
      await expect(checkUpdate(config, NOW + DAY_MS - 1)).resolves.toEqual(update);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [updateRequest, countRequest] = fetchImpl.mock.calls.map(([, init]) => init);
      expect(new Headers(updateRequest?.headers).has("OpenClaw-Installation-Count")).toBe(false);
      expect(updateRequest?.method).toBe(featureStats ? "POST" : "GET");
      expect(countRequest).toEqual({
        method: "POST",
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: {
          "User-Agent": "openclaw-installation-count/1",
          "OpenClaw-Installation-Count": "1;20688;31",
        },
      });
      expect(readConfigMachineState(installationCountStateKey(TELEMETRY_URL))).toBe(20688);
      serverDay = 20689;
      await expect(checkUpdate({}, NOW + DAY_MS)).resolves.toEqual(update);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(
        new Headers(fetchImpl.mock.calls[3]?.[1]?.headers).get("OpenClaw-Installation-Count"),
      ).toBe("1;20689;1");
    },
  );

  it("does not send or claim any installation metadata to a legacy receiver", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(update));
    await expect(checkUpdate({}, NOW, fetchImpl)).resolves.toEqual(update);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(
      new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).has("OpenClaw-Installation-Count"),
    ).toBe(false);
    expect(readConfigMachineState(installationCountStateKey(TELEMETRY_URL))).toBeUndefined();
  });

  it.each(["endpoint", "state directory"] as const)(
    "does not join concurrent update/count cycles for a different %s",
    async (scope) => {
      const response = createDeferredCore<Response>();
      const started = createDeferredCore();
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        if (new Headers(init?.headers).has("OpenClaw-Installation-Count")) {
          return new Response(null, { status: 204 });
        }
        started.resolve();
        return (await response.promise).clone();
      });
      const first = checkUpdate({}, NOW, fetchImpl);
      await started.promise;
      if (scope === "endpoint") {
        setTestEnvValue(
          "OPENCLAW_TELEMETRY_ENDPOINT",
          "https://other.example.invalid/api/latest-version",
        );
      } else {
        setTestEnvValue("OPENCLAW_STATE_DIR", testState.path("other-installation"));
      }
      const second = checkTelemetryUpdate(() => ({}));
      response.resolve(
        Response.json(update, { headers: { "OpenClaw-Installation-Count": "1;20688" } }),
      );
      expect(await Promise.all([first, second])).toEqual([update, update]);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(
        fetchImpl.mock.calls
          .map(([, init]) => new Headers(init?.headers).get("OpenClaw-Installation-Count"))
          .filter(Boolean),
      ).toEqual(["1;20688;31", "1;20688;31"]);
      testState.applyEnv();
    },
  );

  it("cancels an unexpected count-response stream without losing the valid version answer", async () => {
    let canceled = false;
    const receiver = createCountingReceiver();
    const fetchImpl = vi.fn<typeof fetch>(async (...args) =>
      new Headers(args[1]?.headers).has("OpenClaw-Installation-Count")
        ? new Response(
            new ReadableStream({
              cancel() {
                canceled = true;
              },
            }),
          )
        : receiver(...args),
    );
    await expect(checkUpdate({}, NOW, fetchImpl)).resolves.toEqual(update);
    expect(canceled).toBe(true);
    expectState(NOW);
  });

  it.each(["response loss", "HTTP error"])(
    "retains the valid version and never retries its count after %s",
    async (failure) => {
      let serverDay = 20688;
      const receiver = createCountingReceiver(() => serverDay);
      const fetchImpl = vi.fn<typeof fetch>(async (...args) => {
        const init = args[1];
        if (new Headers(init?.headers).has("OpenClaw-Installation-Count")) {
          if (failure === "HTTP error") {
            return new Response(null, { status: 503 });
          }
          throw new Error(failure);
        }
        return receiver(...args);
      });
      await expect(checkUpdate({}, NOW, fetchImpl)).resolves.toEqual(update);
      // A full cache interval can elapse on a skewed client without advancing the receiver day.
      await expect(checkUpdate({}, NOW + DAY_MS)).resolves.toEqual(update);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      serverDay = 20738;
      await expect(checkUpdate({}, NOW + 50 * DAY_MS)).resolves.toEqual(update);
      expect(
        fetchImpl.mock.calls.map(([, init]) =>
          new Headers(init?.headers).get("OpenClaw-Installation-Count"),
        ),
      ).toEqual([null, "1;20688;31", null, null, "1;20738;31"]);
    },
  );

  it("keeps a redirected update answer without authorizing a count upload to its source", async () => {
    const target = "https://other.example.invalid/api/latest-version";
    mockHttp.intercept({
      url: TELEMETRY_URL,
      method: "GET",
      reply: {
        status: 302,
        headers: { location: target },
        body: "",
      },
    });
    mockHttp.intercept({
      url: target,
      method: "GET",
      reply: {
        json: update,
        headers: { "OpenClaw-Installation-Count": "1;20688" },
      },
    });
    await expect(checkUpdate()).resolves.toEqual(update);
    expect(mockHttp.requests()).toHaveLength(2);
    expect(readConfigMachineState(installationCountStateKey(TELEMETRY_URL))).toBeUndefined();
    expectState(NOW);
  });

  it("does not follow a count redirect or discard its accepted update answer", async () => {
    mockHttp.intercept({
      url: TELEMETRY_URL,
      method: "GET",
      reply: {
        json: update,
        headers: { "OpenClaw-Installation-Count": "1;20688" },
      },
    });
    mockHttp.intercept({
      url: TELEMETRY_URL,
      method: "POST",
      reply: {
        status: 307,
        headers: { location: "https://other.example.invalid/count" },
        body: "",
      },
    });
    await expect(checkUpdate()).resolves.toEqual(update);
    expect(mockHttp.requests()).toHaveLength(2);
    expectState(NOW);
  });

  it.each([null, "2;20688", "1;020688", "1;-1", "1;20688;31", "1;20688.5", "1;100000000"])(
    "never claims or sends a count for unsupported capability %j",
    async (capability) => {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        Response.json(update, {
          headers: capability === null ? {} : { "OpenClaw-Installation-Count": capability },
        }),
      );
      await expect(checkUpdate({}, NOW, fetchImpl)).resolves.toEqual(update);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(readConfigMachineState(installationCountStateKey(TELEMETRY_URL))).toBeUndefined();
    },
  );

  it.each([200, 503])("does not count an invalid update answer with HTTP %s", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(status === 200 ? { noVersion: true } : update, {
        status,
        headers: { "OpenClaw-Installation-Count": "1;20688" },
      }),
    );
    await expect(checkUpdate({}, NOW, fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(readConfigMachineState(installationCountStateKey(TELEMETRY_URL))).toBeUndefined();
  });

  it.each([
    { config: { telemetry: { enabled: false } }, dnt: undefined },
    { config: { telemetry: { consentedAt: "2026-08-01T00:00:00Z" } }, dnt: undefined },
    { config: { telemetry: { enabled: true } }, dnt: "1" },
    { config: {}, dnt: "true" },
  ] satisfies { config: OpenClawConfig; dnt: string | undefined }[])(
    "omits counts and feature inventory for declined policy %j",
    async ({ config, dnt }) => {
      if (dnt !== undefined) {
        setTestEnvValue("DO_NOT_TRACK", dnt);
      }
      const fetchImpl = createCountingReceiver();
      await expect(checkUpdate(config, NOW, fetchImpl)).resolves.toEqual(update);
      const init = fetchImpl.mock.calls[0]?.[1];
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("OpenClaw-Installation-Count")).toBeNull();
      expect(readConfigMachineState(installationCountStateKey(TELEMETRY_URL))).toBeUndefined();
    },
  );

  it("keeps update results available without sending a count when its atomic claim fails", async () => {
    sqliteWorkerOwnerProbe.command(workerStore, (command, options, scope) =>
      command.type === "telemetry.claimInstallationCount"
        ? Promise.reject(new Error("Counting storage unavailable"))
        : scope.execute(command, options),
    );
    const fetchImpl = createCountingReceiver();
    await expect(checkUpdate({}, NOW, fetchImpl)).resolves.toEqual(update);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("inspects counting eligibility without inventing a receiver day, claiming, or requesting HTTP", async () => {
    const status = await resolveTelemetryStatus({});
    expect(status.installationCountEnabled).toBe(true);
    expect(readConfigMachineState(installationCountStateKey(TELEMETRY_URL))).toBeUndefined();
    expect(mockHttp.requests()).toHaveLength(0);
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
    expect(serialized).not.toMatch(
      /private-|acme-internal-(?:crm|workflows)|acme-llm|example\.invalid|@/u,
    );
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
    expect(JSON.stringify(payload)).not.toMatch(/private-|\+15555550123/u);
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
    [{ id: "bundled-plugin", origin: "bundled" }, ["bundled-plugin"]],
    [
      { id: "official-plugin", origin: "global", trustedOfficialInstall: true },
      ["official-plugin"],
    ],
    [
      { id: "opencode", origin: "workspace", packageName: "@openclaw/opencode-provider" },
      ["opencode"],
    ],
    [{ id: "opencode", origin: "workspace", packageName: "@acme/private" }, []],
  ] satisfies [Parameters<typeof createPluginRecord>[0], string[]][])(
    "reports only a public identity for %j",
    async (plugin, expected) => {
      installPluginRegistry(plugin);
      const payload = await payloadFor();
      expect(payload.features.plugins).toEqual(expected);
      expect(payload.features.pluginsEnabled).toBe(1);
      expect(JSON.stringify(payload)).not.toContain("@acme/private");
    },
  );

  it("never consults the hosted catalog when reporting private plugin identities", async () => {
    const hostedCatalog = vi
      .spyOn(officialCatalog, "loadConfiguredHostedOfficialExternalPluginCatalogEntries")
      .mockResolvedValue({
        source: "bundled-fallback",
        entries: [{ id: "acme-internal-crm", name: "@acme/internal-crm" }],
        error: "hosted fixture",
      });
    installPluginRegistry({
      id: "acme-internal-crm",
      origin: "global",
      packageName: "@acme/internal-crm",
    });
    const payload = await payloadFor();
    expect(payload.features.plugins).toEqual([]);
    expect(payload.features.pluginsEnabled).toBe(1);
    expect(JSON.stringify(payload)).not.toContain("acme-internal-crm");
    expect(hostedCatalog).not.toHaveBeenCalled();
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
    expectState(NOW, announced.version, announced.note);
    await expect(checkUpdate({}, NOW + DAY_MS - 1)).resolves.toEqual(announced);
    expect(mockHttp.requests()).toHaveLength(1);

    await expect(checkUpdate({}, NOW + DAY_MS)).resolves.toEqual({
      version: "2026.8.25",
    });
    expect(mockHttp.requests()).toHaveLength(2);
    expectState(NOW + DAY_MS, "2026.8.25");
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
    expectState(NOW);
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

  it.each(["opt-out", "do-not-track"])("sends only an anonymous GET for %s", async (mode) => {
    if (mode === "do-not-track") {
      setTestEnvValue("DO_NOT_TRACK", "true");
    }
    mockHttp.intercept({
      url: TELEMETRY_URL,
      method: "GET",
      requestHeaders: {
        "user-agent": `openclaw/${VERSION} (${process.platform}; node/${process.versions.node}; ${process.arch}; gateway)`,
      },
      reply: { json: update },
    });

    await expect(checkUpdate(createFeatureConfig(mode !== "opt-out"))).resolves.toEqual(update);

    expect(mockHttp.requests()).toHaveLength(1);
  });

  it("POSTs exactly the canonical payload only after explicit feature-stats opt-in", async () => {
    const config = createFeatureConfig();
    const expectedBody = JSON.stringify(await payloadFor(config));
    mockHttp.intercept({
      url: TELEMETRY_URL,
      method: "POST",
      requestBody: expectedBody,
      requestHeaders: {
        "content-type": /^application\/json(?:\s*;.*)?$/u,
      },
      reply: { json: update },
    });

    await expect(checkUpdate(config)).resolves.toEqual(update);

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

  it.each([TELEMETRY_URL, "https://TELEMETRY.OPENCLAW.AI.:443/another-path?test=1"])(
    "never reports from CI with an explicit production endpoint: %s",
    async (endpoint) => {
      setTestEnvValue("CI", "true");
      setTestEnvValue("OPENCLAW_TELEMETRY_ENDPOINT", endpoint);

      await expect(checkUpdate(createFeatureConfig())).resolves.toBeNull();

      expect(mockHttp.requests()).toHaveLength(0);
      expect(readState()).toBeUndefined();
      expect((await resolveTelemetryStatus(createFeatureConfig())).reason).toBe(
        "automated-environment",
      );
    },
  );

  it("still reports to a custom test receiver in CI", async () => {
    const endpoint = "https://telemetry.example.invalid/api/latest-version";
    setTestEnvValue("CI", "true");
    setTestEnvValue("OPENCLAW_TELEMETRY_ENDPOINT", endpoint);
    respond(update.version, endpoint);

    await expect(checkUpdate()).resolves.toEqual(update);

    expect(mockHttp.requests()).toHaveLength(1);
  });

  it("never follows a test receiver redirect to production in CI", async () => {
    const endpoint = "https://telemetry.example.invalid/api/latest-version";
    setTestEnvValue("CI", "true");
    setTestEnvValue("OPENCLAW_TELEMETRY_ENDPOINT", endpoint);
    mockHttp.intercept({
      url: endpoint,
      reply: { status: 307, headers: { location: TELEMETRY_URL }, body: "" },
    });

    await expect(checkUpdate()).resolves.toBeNull();

    expect(mockHttp.requests()).toHaveLength(1);
    expect(readState()).toBeUndefined();
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
    expectState(NOW);
    await expect(checkUpdate({}, NOW + DAY_MS + 30_001, fetchImpl)).resolves.toEqual(update);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
