// A config writer receives the committed revision before its own policy retires its socket.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configPublication from "../config/backup-rotation.js";
import { readConfigFileSnapshot } from "../config/config.js";
import * as configWriteMetadata from "../config/io.meta.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import * as restartSentinel from "../infra/restart-sentinel.js";
import { resetLogger } from "../logging/logger.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { GatewayClient, isGatewayProtocolResponseError } from "./client.js";
import { invalidateConfigGetResponseCache } from "./config-get-response.js";
import { startGatewayServerCore } from "./server-start.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";

type ConfigSnapshot = { hash: string; config: OpenClawConfig };
type ConfigAck = { hash: string; sentinel: { payload: { stats: { requiresRestart: boolean } } } };

describe("config writer policy-close ordering", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
  const clients: GatewayClient[] = [];
  const scopes = ["operator.admin", "operator.read", "operator.write"];
  async function connectClient(
    port: number,
    options: Pick<
      ConstructorParameters<typeof GatewayClient>[0],
      "token" | "deviceToken" | "deviceIdentity" | "clientName" | "mode" | "origin"
    >,
  ) {
    const connected = createDeferredCore();
    const closed = createDeferredCore();
    let didClose = false;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      clientName: "gateway-client",
      clientVersion: "1.0.0",
      mode: "backend",
      deviceIdentity: null,
      scopes,
      ...options,
      hostDeps: {
        loadDeviceAuthToken: () => null,
        storeDeviceAuthToken: () => {},
        clearDeviceAuthToken: () => {},
      },
      onHelloOk: () => connected.resolve(),
      onConnectError: (error) => connected.reject(error),
      onClose: (code, reason) => {
        didClose = true;
        client.stop();
        connected.reject(new Error(`closed ${code}: ${reason}`));
        closed.resolve();
      },
    });
    clients.push(client);
    client.start();
    await connected.promise;
    return { client, closed: closed.promise, didClose: () => didClose };
  }
  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "config-policy-response",
      env: {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        CONFIG_PROVENANCE_API_KEY: "synthetic-included-env-key",
      },
    });
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.stopAndWait()));
    await server?.close();
    server = undefined;
    await state.cleanup();
    resetLogger();
    clearPluginMetadataLifecycleCaches();
    vi.restoreAllMocks();
  });

  it.each(["root", "include"] as const)(
    "refuses a revoked requester before publishing its prepared %s config",
    async (target) => {
      const token = "config-publication-admin-token";
      const gateway: NonNullable<OpenClawConfig["gateway"]> = {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        reload: { mode: "hybrid" },
      };
      const includePath = state.statePath("gateway.json5");
      if (target === "include") {
        await state.writeJson("gateway.json5", gateway);
      }
      await state.writeConfig({
        gateway: target === "include" ? { $include: "./gateway.json5" } : gateway,
        logging: { level: "silent", consoleLevel: "silent" },
        agents: { defaults: { workspace: state.workspaceDir } },
      });
      const port = await getFreePort();
      server = await startGatewayServerCore(port, { controlUiEnabled: false });
      await server.startupSettled;
      const identity = loadOrCreateDeviceIdentity({
        path: state.path("writer-identity", "client", "credentials.sqlite"),
      });
      const pairing = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        role: "operator",
        scopes,
        clientId: "gateway-client",
        clientMode: "backend",
      });
      const approval = await approveDevicePairing(pairing.request.requestId, {
        callerScopes: scopes,
      });
      const deviceToken =
        approval?.status === "approved" ? approval.device.tokens?.operator?.token : undefined;
      if (!deviceToken) {
        throw new Error("Expected a real paired writer token");
      }
      const writer = await connectClient(port, { deviceToken, deviceIdentity: identity });
      const admin = await connectClient(port, { token });
      const before = await writer.client.request<ConfigSnapshot>("config.get");
      const writtenPath = target === "include" ? includePath : state.configPath;
      await fs.writeFile(`${writtenPath}.bak`, "retained latest backup\n");
      await fs.writeFile(`${writtenPath}.bak.1`, "retained previous backup\n");
      const captureFiles = async () => {
        const basenames = [path.basename(state.configPath), path.basename(includePath)];
        const names = (await fs.readdir(path.dirname(state.configPath)))
          .filter((name) =>
            basenames.some((base) => name === base || name.startsWith(`${base}.bak`)),
          )
          .toSorted();
        return await Promise.all(
          names.map(async (name) => ({
            name,
            bytes: await fs.readFile(path.join(path.dirname(state.configPath), name)),
          })),
        );
      };
      const beforeFiles = await captureFiles();
      const prepared = createDeferredCore();
      const release = createDeferredCore();
      const publish = vi.fn();
      const prepareFile = configPublication.prepareConfigFileWrite;
      vi.spyOn(configPublication, "prepareConfigFileWrite").mockImplementation(async (params) => {
        const file = await prepareFile(params);
        if (params.configPath === writtenPath) {
          // Hold real prepared bytes; retain the original disposable and publication owner.
          const publishFile = file.publish.bind(file);
          vi.spyOn(file, "publish").mockImplementation(() => {
            publish();
            return publishFile();
          });
          prepared.resolve();
          await release.promise;
        }
        return file;
      });
      const result = writer.client
        .request("config.patch", {
          baseHash: before.hash,
          raw: JSON.stringify({
            gateway: { controlUi: { allowedOrigins: ["https://next.example.test"] } },
          }),
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      try {
        await Promise.race([
          prepared.promise,
          result.then(() => {
            throw new Error("Config request settled before the publication barrier");
          }),
        ]);
        const revoked = await admin.client.request("device.token.revoke", {
          deviceId: identity.deviceId,
          role: "operator",
        });
        expect(revoked).toMatchObject({
          deviceId: identity.deviceId,
          role: "operator",
          revokedAtMs: expect.any(Number),
        });
        // The response hold postpones close; release preparation before waiting for the socket.
        release.resolve();
        const outcome = await result;
        expect(outcome.ok).toBe(false);
        if (outcome.ok) {
          throw new Error("Revoked config publication unexpectedly succeeded");
        }
        expect(isGatewayProtocolResponseError(outcome.error)).toBe(true);
        expect(outcome.error).toMatchObject({
          code: "UNAVAILABLE",
          message: expect.stringContaining("Gateway requester authority changed"),
        });
        expect(publish).not.toHaveBeenCalled();
        expect(await captureFiles()).toEqual(beforeFiles);
        expect(await admin.client.request<ConfigSnapshot>("config.get")).toEqual(before);
        await writer.closed;
      } finally {
        release.resolve();
        await result;
      }
    },
  );

  it.each([
    { method: "config.patch", policy: "token" },
    { method: "config.apply", policy: "origin" },
    { method: "config.patch", policy: "publicOrigin" },
  ] as const)(
    "acknowledges $method before closing its $policy-revoked writer",
    async ({ method, policy }) => {
      const token = "config-response-old-token";
      const nextToken = "config-response-new-token";
      const origin = "https://writer.example.test";
      const nextOrigin = "https://retained.example.test";
      const browserPolicy = policy !== "token";
      await state.writeConfig({
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "token", token },
          controlUi: {
            enabled: false,
            ...(policy === "publicOrigin" ? {} : { allowedOrigins: [origin] }),
          },
          reload: { mode: "hybrid" },
        },
        logging: { level: "silent", consoleLevel: "silent" },
        agents: { defaults: { workspace: state.workspaceDir } },
      });
      const port = await getFreePort();
      server = await startGatewayServerCore(port, {
        controlUiEnabled: false,
        ...(policy === "publicOrigin" ? { bind: "lan" } : {}),
      });
      await server.startupSettled;
      const held = createDeferredCore();
      const filePublished = createDeferredCore();
      const finishMetadata = createDeferredCore();
      const published = createDeferredCore<restartSentinel.RestartSentinelPayload>();
      const writeSentinel = restartSentinel.writeRestartSentinel;
      const connect = (credential: string, browser = false, browserOrigin = origin) =>
        connectClient(port, {
          token: credential,
          clientName: browser ? "openclaw-control-ui" : "gateway-client",
          mode: browser ? "webchat" : "backend",
          ...(browser ? { origin: browserOrigin } : {}),
          deviceIdentity: browser
            ? loadOrCreateDeviceIdentity({
                path: state.path("browser-identity", "client", "credentials.sqlite"),
              })
            : null,
        });
      if (policy === "publicOrigin") {
        // Adding the public origin must supersede the runtime-only localhost seed.
        const setup = await connect(token);
        const snapshot = await setup.client.request<ConfigSnapshot>("config.get");
        await setup.client.request("config.patch", {
          baseHash: snapshot.hash,
          raw: JSON.stringify({ gateway: { publicOrigin: origin } }),
        });
      }
      vi.spyOn(restartSentinel, "writeRestartSentinel").mockImplementation(async (payload) => {
        published.resolve(payload);
        await held.promise;
        return await writeSentinel(payload);
      });
      const recordMetadata = configWriteMetadata.recordConfigWriteMetadata;
      vi.spyOn(configWriteMetadata, "recordConfigWriteMetadata").mockImplementationOnce(
        async (...args) => {
          // Let the real watcher revoke the requester after publication but before reread.
          filePublished.resolve();
          await finishMetadata.promise;
          await recordMetadata(...args);
        },
      );
      try {
        const writer = await connect(token, browserPolicy);
        const peer = await connect(token, browserPolicy);
        const before = await writer.client.request<ConfigSnapshot>("config.get");
        const change =
          policy === "token"
            ? { gateway: { auth: { token: nextToken } } }
            : policy === "publicOrigin"
              ? { gateway: { publicOrigin: nextOrigin } }
              : { gateway: { controlUi: { allowedOrigins: [nextOrigin] } } };
        const nextConfig = structuredClone(before.config);
        nextConfig.gateway = {
          ...nextConfig.gateway,
          ...(policy === "token"
            ? { auth: { ...nextConfig.gateway?.auth, token: nextToken } }
            : policy === "publicOrigin"
              ? { publicOrigin: nextOrigin }
              : {
                  controlUi: {
                    ...nextConfig.gateway?.controlUi,
                    allowedOrigins: [nextOrigin],
                  },
                }),
        };
        const result = writer.client.request<ConfigAck>(method, {
          baseHash: before.hash,
          raw: JSON.stringify(method === "config.apply" ? nextConfig : change),
        });
        void result.catch(() => {});
        await Promise.race([
          filePublished.promise,
          result.then(() => {
            throw new Error("RPC completed before config publication");
          }),
        ]);
        await peer.closed;
        expect(writer.didClose()).toBe(false);
        finishMetadata.resolve();
        const publication = await Promise.race([
          published.promise,
          result.then(() => {
            throw new Error("RPC completed before its sentinel");
          }),
        ]);
        expect(publication.stats?.requiresRestart).toBe(false);
        await peer.closed;
        expect(writer.didClose()).toBe(false);
        const staleRead = writer.client.request("health");
        void staleRead.catch(() => {});
        held.resolve();
        const response = await result;
        expect(response).toMatchObject({
          hash: expect.any(String),
          sentinel: { payload: { stats: { requiresRestart: false } } },
        });
        expect(response.hash).not.toBe(before.hash);
        await writer.closed;
        await expect(staleRead).rejects.toThrow();
        const fresh = await connect(
          policy === "token" ? nextToken : token,
          browserPolicy,
          nextOrigin,
        );
        expect((await fresh.client.request<ConfigSnapshot>("config.get")).hash).toBe(response.hash);
      } finally {
        finishMetadata.resolve();
        held.resolve();
      }
    },
  );
  describe("config security policy before persistence", () => {
    const token = "config-security-policy-test-token";
    const makeConfig = (gateway: NonNullable<OpenClawConfig["gateway"]>) =>
      ({
        agents: { defaults: { workspace: state.workspaceDir } },
        logging: { level: "silent", consoleLevel: "silent" },
        gateway: { mode: "local", auth: { mode: "token", token }, ...gateway },
      }) satisfies OpenClawConfig;

    async function start(
      cfg: OpenClawConfig,
      options: Pick<Parameters<typeof connectGatewayClient>[0], "scopes" | "onHelloOk">,
      recover = false,
    ) {
      await state.writeConfig(cfg);
      const port = await getFreePort();
      server = await startGatewayServerCore(port, {
        hotReloadRecovery: recover ? () => ({ status: "emitted" }) : undefined,
      });
      await server.startupSettled;
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        ...options,
      });
      clients.push(client);
      return client;
    }

    it("keeps authored provenance out of valid and invalid read-scoped config.get responses", async () => {
      const inlineKey = "synthetic-provider-key";
      const envKey = "synthetic-included-env-key";
      const provider = (apiKey: string) => ({
        baseUrl: "https://example.test",
        apiKey,
        models: [],
      });
      const models = {
        providers: {
          inline: provider(inlineKey),
          referenced: provider("${CONFIG_PROVENANCE_API_KEY}"),
        },
      };
      await state.writeJson("models.json", models);
      let grantedScopes: string[] | undefined;
      const reader = await start(
        makeConfig({ controlUi: { enabled: false }, reload: { mode: "off" } }),
        {
          scopes: ["operator.read"],
          onHelloOk: (hello) => {
            grantedScopes = hello.auth.scopes;
          },
        },
      );
      expect(grantedScopes).toEqual(["operator.read"]);

      // Keep one admitted reader while the on-disk snapshot becomes invalid.
      // Direct fixture writes must invalidate cached config.get responses.
      for (const useInclude of [false, true]) {
        for (const valid of [true, false]) {
          await state.writeConfig({
            gateway: { reload: { mode: "off" } },
            models: useInclude ? { $include: "models.json" } : models,
            ...(valid ? {} : { nodeHost: { browserProxy: { enabled: "invalid" } } }),
          });
          invalidateConfigGetResponseCache();
          const snapshot = await readConfigFileSnapshot({ observe: false });
          expect(snapshot.valid).toBe(valid);
          expect(snapshot.authoredConfig?.models).toEqual(models);
          expect(snapshot.sourceConfigBeforeMigrations?.models?.providers?.referenced?.apiKey).toBe(
            envKey,
          );
          const before = structuredClone(snapshot);
          const response = await reader.request("config.get", {});
          const serialized = JSON.stringify(response);

          expect(response.valid).toBe(valid);
          expect(response).not.toHaveProperty("authoredConfig");
          expect(response).not.toHaveProperty("sourceConfigBeforeMigrations");
          for (const canary of [token, inlineKey, envKey]) {
            expect(serialized).not.toContain(canary);
          }
          expect(snapshot).toEqual(before);
          expect(await readConfigFileSnapshot({ observe: false })).toMatchObject({
            authoredConfig: snapshot.authoredConfig,
            sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
          });
        }
      }
    });

    it.each([
      { method: "config.patch", disableUi: false },
      { method: "config.apply", disableUi: true },
    ])(
      "validates $method clearing LAN origins (disableUi=$disableUi)",
      async ({ method, disableUi }) => {
        await state.writeText("control-ui/index.html", "<!doctype html><title>Control UI</title>");
        const initialConfig = makeConfig({
          bind: "lan",
          controlUi: {
            enabled: true,
            root: state.statePath("control-ui"),
            allowedOrigins: ["https://control.example.test"],
          },
          reload: { mode: "hybrid" },
        });
        const writer = await start(initialConfig, { scopes: ["operator.admin"] }, true);
        const before = await writer.request<{ hash: string }>("config.get", {});
        const beforeBytes = await fs.readFile(state.configPath, "utf8");
        const controlUi = { ...(disableUi ? { enabled: false } : {}), allowedOrigins: [] };
        const nextConfig = structuredClone(initialConfig);
        nextConfig.gateway.controlUi = { ...nextConfig.gateway.controlUi, ...controlUi };
        const outcome = writer.request(method, {
          baseHash: before.hash,
          raw: JSON.stringify(method === "config.patch" ? { gateway: { controlUi } } : nextConfig),
          ...(method === "config.patch"
            ? { replacePaths: ["gateway.controlUi.allowedOrigins"] }
            : {}),
        });
        if (disableUi) {
          await expect(outcome).resolves.toMatchObject({
            sentinel: { payload: { stats: { requiresRestart: false } } },
          });
          expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toMatchObject({
            gateway: { controlUi: { enabled: false, allowedOrigins: [] } },
          });
        } else {
          await expect(outcome).rejects.toMatchObject({
            message: expect.stringContaining("non-loopback Control UI requires"),
          });
          expect(await fs.readFile(state.configPath, "utf8")).toBe(beforeBytes);
          expect((await writer.request<{ hash: string }>("config.get", {})).hash).toBe(before.hash);
        }
      },
    );
  });
});
