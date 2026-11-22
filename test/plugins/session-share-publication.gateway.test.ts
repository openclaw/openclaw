// Real TLS, signed pairing and plugin registration; minimal startup skips discovery.
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import https from "node:https";
import tls from "node:tls";
import { loadGatewayReaderIdentityV1 } from "openclaw/plugin-sdk/gateway-runtime";
import * as transcript from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, expect, it, vi } from "vitest";
import sessionShare from "../../extensions/session-share/index.js";
import { captureRuntimeConfigAsyncReader } from "../../src/config/config.js";
import { setRuntimeConfigSnapshot } from "../../src/config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "../../src/gateway/server-methods/types.js";
import { startGatewayServerCore } from "../../src/gateway/server-start.js";
import { createProductState } from "../../src/gateway/server.chat-product.test-support.js";
import * as gatewayClient from "../../src/gateway/test-helpers.e2e.js";
import {
  acquireGatewayE2ePortBlock,
  startClaimedGateway,
} from "../../src/gateway/test-helpers.listener.js";
import {
  setTestPluginRegistry,
  resetTestPluginRegistry,
} from "../../src/gateway/test-helpers.plugin-registry.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../src/infra/device-identity.js";
import { approveDevicePairing } from "../../src/infra/device-pairing-approval.js";
import { rotateDeviceToken } from "../../src/infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../../src/infra/device-pairing.js";
import { createPluginRecord } from "../../src/plugins/loader-records.js";
import { createRuntimeTestRegistry } from "../../src/plugins/registry-runtime.test-helpers.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import { createDeferredCore } from "../../src/shared/deferred.js";
import { openOpenClawStateDatabase } from "../../src/state/openclaw-state-db.js";
import { mergeCanonicalUserProfiles } from "../../src/state/user-profile-writes.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";
import { acquireTestPortBlock } from "../../src/test-utils/port-claims.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../helpers/tls-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetTestPluginRegistry();
});
const scope = "operator.session-share.read";

it.each([false, true])(
  "publishes only the signed device's configured cohort over WSS (roles=%s)",
  { timeout: 120_000 },
  async (roles) => {
    const state = await createProductState("session-share-publication");
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => state.cleanup());
    state.envVars.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
    state.applyEnv();
    const person = ensureProfileForEmail("publisher@example.test");
    const other = ensureProfileForEmail("other@example.test");
    const alias = ensureProfileForEmail("alias@example.test");
    await mergeCanonicalUserProfiles(alias.id, person.id);
    const identityKey = "session-share-proof";
    const identity = loadOrCreateDeviceIdentity({ identityKey });
    expect(identity.deviceId).not.toBe(loadOrCreateDeviceIdentity().deviceId);
    const pendingPair = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      scopes: [scope],
      role: "operator",
      clientId: "gateway-client",
      clientMode: "backend",
    });
    const approved = await approveDevicePairing(pendingPair.request.requestId, {
      callerScopes: ["operator.admin"],
    });
    expect(approved?.status).toBe("approved");
    const issued = await rotateDeviceToken({
      deviceId: identity.deviceId,
      role: "operator",
      scopes: [scope],
    });
    if (!issued.ok) {
      throw new Error(`Fixture token refused: ${issued.reason}`);
    }
    const device = {
      identity: await loadGatewayReaderIdentityV1(identityKey),
      issued: issued.entry,
    };
    const share = {
      gateway: true,
      groups: ["Team"],
      involvingProfileId: alias.id,
      gatewayDeviceIds: [device.identity.deviceId],
    };
    const tlsConfig = { cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM };
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
      plugins: {
        entries: { "session-share": { enabled: true, config: { share } } },
        slots: { memory: "none" },
      },
      gateway: {
        sessionControl: { publicationReadEnabled: true },
        auth: { mode: "token", token: "synthetic-gateway-secret" },
        tls: {
          enabled: true,
          autoGenerate: false,
          certPath: await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM),
          keyPath: await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM),
        },
      },
    };
    if (roles) {
      cfg.gateway!.roles = {
        default: "member",
        definitions: {
          member: { scopes: ["operator.read"], agents: [], sessions: { others: "none" } },
        },
      };
    }
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    const runtime = createPluginRuntime();
    let currentConfig = cfg;
    runtime.config.current = () => currentConfig;
    const registry = createRuntimeTestRegistry(runtime);
    sessionShare.register(
      registry.createApi(
        createPluginRecord({
          id: "session-share",
          source: "/plugins/session-share/index.js",
          origin: "bundled",
          enabled: true,
          configSchema: false,
        }),
        { config: cfg },
      ),
    );
    let nativeConsumerDepth = 0;
    const consumeEntries = runtime.agent.session.withSessionEntriesAsync;
    vi.spyOn(runtime.agent.session, "withSessionEntriesAsync").mockImplementation(
      (params, consume) =>
        consumeEntries(params, (entries) => {
          nativeConsumerDepth++;
          try {
            return consume(entries);
          } finally {
            nativeConsumerDepth--;
          }
        }),
    );
    let admitted: GatewayRequestHandlerOptions | undefined;
    const handler = registry.registry.gatewayHandlers["session-share.list"]!;
    registry.registry.gatewayHandlers["session-share.list"] = (request) => {
      admitted = request;
      return handler({
        ...request,
        respond: (ok, payload, error, meta) => {
          if (ok) {
            expect(nativeConsumerDepth).toBeGreaterThan(0);
          }
          request.respond(ok, payload, error, meta);
        },
      });
    };
    registry.registry.gatewayMethodDescriptors.find(
      (entry) => entry.name === "session-share.list",
    )!.handler = registry.registry.gatewayHandlers["session-share.list"]!;
    setTestPluginRegistry(registry.registry);
    for (const [name, id, category] of [
      ["shared", person.id, "Team"],
      ["other", other.id, "Team"],
      ["private", person.id, "Private"],
    ]) {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: `agent:main:${name}` },
        {
          sessionId: name!,
          updatedAt: Date.now(),
          category,
          createdActor: { type: "human", source: "profile", id },
        },
      );
    }
    await transcript.appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionKey: "agent:main:shared",
      sessionId: "shared",
      message: { role: "user", content: "SYNTHETIC_SHARED_MESSAGE" },
    });
    const claim = await acquireGatewayE2ePortBlock();
    const gateway = await startClaimedGateway(claim, () =>
      startGatewayServerCore(claim.port, { controlUiEnabled: false }),
    );
    cleanup.defer(() => gateway.close({ reason: "session-share proof complete" }));
    await gateway.startupSettled;
    // Local Access-shaped edge proves header delivery, not live Cloudflare policy.
    const edgeClaim = await acquireTestPortBlock({ offsets: [0] });
    const edge = https.createServer(tlsConfig);
    let edgeHeadersSeen = false;
    edge.on("upgrade", (request, socket, head) => {
      edgeHeadersSeen =
        request.headers["cf-access-client-id"] === "synthetic-edge-id" &&
        request.headers["cf-access-client-secret"] === "synthetic-edge-secret";
      if (!edgeHeadersSeen) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = tls.connect(
        { host: "127.0.0.1", port: claim.port, rejectUnauthorized: false },
        () => {
          // The deliberately expired test certificate is authenticated by its exact pin.
          if (
            new X509Certificate(upstream.getPeerCertificate(true).raw).fingerprint256 !==
            new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256
          ) {
            upstream.destroy();
            socket.destroy();
            return;
          }
          upstream.write(
            `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${request.rawHeaders.reduce((text, value, index) => text + value + (index % 2 ? "\r\n" : ": "), "")}\r\n`,
          );
          if (head.length) {
            upstream.write(head);
          }
          socket.pipe(upstream).pipe(socket);
        },
      );
      cleanup.defer(() => {
        socket.destroy();
        upstream.destroy();
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    edge.listen(edgeClaim.port, "127.0.0.1");
    cleanup.defer(async () => {
      await new Promise<void>((resolve) => {
        edge.close(() => resolve());
      });
      await edgeClaim.release();
    });
    await once(edge, "listening");
    let advertised: string[] = [];
    const client = await gatewayClient.connectGatewayClient({
      url: `wss://127.0.0.1:${edgeClaim.port}`,
      onHelloOk: (hello) => {
        advertised = hello.features.methods;
      },
      edgeAuthHeaders: {
        "CF-Access-Client-Id": "synthetic-edge-id",
        "CF-Access-Client-Secret": "synthetic-edge-secret",
      },
      deviceIdentity: device.identity,
      deviceToken: device.issued!.token,
      scopes: [scope],
      clientName: "gateway-client",
      mode: "backend",
      tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
    });
    cleanup.defer(() => gatewayClient.disconnectGatewayClient(client));
    expect(edgeHeadersSeen).toBe(true);
    expect(advertised.toSorted()).toEqual(["session-share.list", "session-share.read"]);
    const list = () =>
      client.request<{ sessions: { threadId: string }[] }>("session-share.list", {});
    const read = (name = "shared") =>
      client.request<{ items: { text?: string }[] }>("session-share.read", {
        threadId: `agent:main:${name}`,
      });
    const listed = (await list()).sessions;
    expect(listed.map((row) => row.threadId)).toEqual(["agent:main:shared"]);
    expect(listed[0]).toMatchObject({
      canContinue: false,
      canArchive: false,
      canOpenTerminal: false,
    });
    expect((await read()).items).toMatchObject([{ text: "SYNTHETIC_SHARED_MESSAGE" }]);
    expect(admitted).toBeDefined();
    expect(admitted?.client?.authenticatedUserProfile).toBeUndefined();
    expect(admitted?.client?.preparedSessionProfile).toBeUndefined();
    for (const name of ["other", "private"]) {
      await expect(read(name)).rejects.toThrow();
    }
    for (const method of ["sessions.list", "chat.history", "config.get", "sessions.send"]) {
      await expect(client.request(method, {})).rejects.toThrow();
    }
    await expect(
      client.request("session-share.list", { involvingProfileId: other.id }),
    ).rejects.toThrow();
    for (const patch of [
      { gateway: false },
      { gatewayDeviceIds: [] },
      { gatewayDeviceIds: ["unpaired-device"] },
      { involvingProfileId: "missing-person" },
      { involvingProfileId: "" },
      { groups: ["Missing"] },
      { involvingProfileId: other.id },
    ]) {
      const saved = { ...share };
      Object.assign(share, patch);
      try {
        await expect(read()).rejects.toThrow();
      } finally {
        Object.assign(share, saved);
      }
    }
    cfg.plugins!.entries!["session-share"]!.enabled = false;
    await expect(read()).rejects.toThrow();
    cfg.plugins!.entries!["session-share"]!.enabled = true;
    const holdRead = async (mutate: () => void | Promise<unknown>, disclose = false) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const original = transcript.readSessionTranscriptCatalogPage;
      vi.spyOn(transcript, "readSessionTranscriptCatalogPage").mockImplementationOnce(
        async (...args) => {
          const page = await original(...args);
          entered.resolve();
          await release.promise;
          return page;
        },
      );
      const pending = read();
      const checked = disclose
        ? expect(pending).resolves.toMatchObject({
            items: [{ text: "SYNTHETIC_SHARED_MESSAGE" }],
          })
        : expect(pending).rejects.toThrow();
      try {
        await Promise.race([entered.promise, pending]);
        await mutate();
      } finally {
        release.resolve();
      }
      await checked;
    };
    const publishReaderEnabled = (enabled: boolean) => {
      currentConfig = {
        ...cfg,
        gateway: { ...cfg.gateway, sessionControl: { publicationReadEnabled: enabled } },
      };
      setRuntimeConfigSnapshot(currentConfig);
    };
    await holdRead(() => {
      publishReaderEnabled(false);
    }, true);
    await expect(read()).rejects.toThrow();
    publishReaderEnabled(true);
    expect((await read()).items).toMatchObject([{ text: "SYNTHETIC_SHARED_MESSAGE" }]);
    await holdRead(() => {
      share.gatewayDeviceIds = [];
    });
    share.gatewayDeviceIds = [device.identity.deviceId];
    await holdRead(() => {
      share.groups = ["Private"];
    });
    share.groups = ["Team"];
    let rotated!: Awaited<ReturnType<typeof rotateDeviceToken>>;
    await holdRead(async () => {
      rotated = await rotateDeviceToken({
        deviceId: device.identity.deviceId,
        role: "operator",
        scopes: [scope],
      });
    });
    await expect(list()).rejects.toThrow();
    if (!rotated.ok) {
      throw new Error(`Fixture rotation refused: ${rotated.reason}`);
    }
    const fresh = await gatewayClient.connectGatewayClient({
      url: `wss://127.0.0.1:${claim.port}`,
      deviceIdentity: device.identity,
      deviceToken: rotated.entry.token,
      scopes: [scope],
      clientName: "gateway-client",
      mode: "backend",
      tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
    });
    cleanup.defer(() => gatewayClient.disconnectGatewayClient(fresh));
    expect(
      (await fresh.request<{ sessions: unknown[] }>("session-share.list", {})).sessions,
    ).toHaveLength(1);
    // Model another process removing the canonical person from the isolated store.
    openOpenClawStateDatabase().db.prepare("DELETE FROM user_profiles WHERE id = ?").run(person.id);
    await expect(
      fresh.request("session-share.read", { threadId: "agent:main:shared" }),
    ).rejects.toThrow();
  },
);
