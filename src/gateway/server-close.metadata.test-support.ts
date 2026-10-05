// Shared real Gateway metadata/cache fixture; startup joins owned audit maintenance.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { Value } from "typebox/value";
import { vi } from "vitest";
import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  ResponseFrameSchema,
  type ResponseFrame,
} from "../../packages/gateway-protocol/src/index.js";
import { createGatewayHostLifecycle } from "../cli/gateway-cli/host-lifecycle.js";
import {
  upsertSessionEntryCore,
  appendTranscriptMessage,
} from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { getPluginMetadataSnapshotCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginValueInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getPluginSetupModuleLoader } from "../plugins/plugin-setup-module.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  isGatewayWriterRetired,
  runWithGatewayWriterRetirementCleanup,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  ensureCanonicalFactoryGitHubProfile,
  setCanonicalUserProfileRole,
  setCanonicalUserProfileAvatar,
} from "../state/user-profile-writes.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayServer, GatewayServerOptions } from "./server-public.js";
import { startGatewayServerCore } from "./server-start.js";
import { loadSessionEntry } from "./session-utils.js";
import { reserveGatewayTestListener } from "./test-helpers.listener.js";
// Keep cold source transformation of mandatory startup code outside behavior-test deadlines.
import "./server-reload-managed.js";

export async function createGatewayMetadataCloseFixture(label: string) {
  const original = captureActivePluginRegistrySnapshot();
  const state = await createOpenClawTestState({
    label,
    layout: "home",
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      VITEST: "1",
    },
  });
  const pluginId = "metadata-fixture";
  const rootDir = state.path(pluginId);
  await fs.mkdir(rootDir);
  await fs.writeFile(
    path.join(rootDir, "package.json"),
    JSON.stringify({
      name: pluginId,
      version: "1.0.0",
      type: "commonjs",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      activation: { onStartup: true },
      configSchema: { type: "object", properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "index.cjs"),
    `module.exports = { id: ${JSON.stringify(pluginId)}, register() {} };`,
  );
  const source = path.join(rootDir, "callback.cjs");
  const dependency = path.join(rootDir, "lazy.mjs");
  const event = `${label}-setup`;
  const listeners = process.listenerCount(event);
  const writeCallback = async (value: string) => {
    await fs.writeFile(dependency, `export const value = ${JSON.stringify(value)};`);
    await fs.writeFile(
      source,
      `module.exports = (lifecycle) => {
        const listener = () => {};
        process.on(${JSON.stringify(event)}, listener);
        lifecycle.onDispose(() => process.off(${JSON.stringify(event)}, listener));
        return async () => (await import("./lazy.mjs")).value;
      };`,
    );
  };
  await writeCallback("captured");
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: state.workspaceDir } },
    plugins: {
      allow: [pluginId],
      entries: { [pluginId]: { enabled: true } },
      load: { paths: [rootDir] },
      slots: { memory: "none" },
    },
  };
  const kernels = new Map<number, Awaited<ReturnType<typeof createGatewayKernel>>>();
  const servers: GatewayServer[] = [];
  const reservedListeners = new Map<
    number,
    Awaited<ReturnType<typeof reserveGatewayTestListener>>
  >();
  const reservePort = async (port = 0) => {
    const reservation = await reserveGatewayTestListener(port);
    reservedListeners.set(reservation.port, reservation);
    return reservation.port;
  };
  const create = createGatewayKernel;
  const audit = await import("../audit/audit-event-writer.js");
  const createAuditWriter = audit.createAuditEventWriter;
  const auditReadiness = new Set<Promise<void>>();
  const auditFactory = vi.spyOn(audit, "createAuditEventWriter").mockImplementation((options) => {
    const writer = createAuditWriter(options);
    auditReadiness.add(writer.ready);
    return writer;
  });
  const health = await import("./server/event-loop-health.js");
  const createHealthMonitor = health.createGatewayEventLoopHealthMonitor;
  const healthFactory = vi
    .spyOn(health, "createGatewayEventLoopHealthMonitor")
    .mockImplementation((...args) => {
      const monitor = createHealthMonitor(...args);
      // Real CPU sampling can arm timeouts after callers install a controlled clock.
      monitor.stop();
      return monitor;
    });
  setActivePluginRegistry(createEmptyPluginRegistry());
  return {
    state,
    config,
    kernels,
    pluginId,
    rootDir,
    dependency,
    event,
    listeners,
    writeCallback,
    reservePort,
    loadCallback(metadata: PluginMetadataSnapshot) {
      const record = metadata.manifestRegistry.plugins.find((entry) => entry.id === pluginId);
      assert(record);
      return withPluginCache(getPluginMetadataSnapshotCache(metadata), () => {
        const setup = getPluginSetupModuleLoader(record, source, rootDir);
        const initialize = setup(source);
        assert(typeof initialize === "function");
        const owner = getPluginValueInstance(initialize);
        assert(owner);
        const callback = setup.initialize(() => initialize(owner.lifecycle));
        assert(typeof callback === "function");
        return callback;
      });
    },
    async start(port: number, options?: GatewayServerOptions) {
      let listener = reservedListeners.get(port);
      assert(listener, "Reserve the Gateway listener before starting it");
      // Explicit same-endpoint restarts bind anew after the prior Gateway closes.
      if (!listener.listener.listening) {
        await reservePort(port);
        listener = reservedListeners.get(port)!;
      }
      const token = `metadata-close-token-${port}`;
      await state.writeConfig({
        ...config,
        gateway: {
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          ...config.gateway,
          port,
          reload: config.gateway?.reload ?? { mode: "off" },
        },
      });
      const factory = vi
        .spyOn(await import("./server-kernel.js"), "createGatewayKernel")
        .mockImplementation(async (...args) => {
          const kernel = await create(...args);
          kernels.set(args[0] ?? 18789, kernel);
          return kernel;
        });
      let server: GatewayServer;
      try {
        server = await listener.start(() =>
          startGatewayServerCore(port, {
            auth: { mode: "token", token },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
            ...options,
          }),
        );
        servers.push(server);
      } catch (error) {
        await listener.closeUnadopted();
        throw error;
      } finally {
        factory.mockRestore();
      }
      await server.startupSettled;
      // Initial audit pruning admits a worker and arms its idle timer. Finish
      // that real-clock setup before callers install a controlled test clock.
      await Promise.all(auditReadiness);
      return server;
    },
    async cleanup() {
      try {
        for (const server of servers.toReversed()) {
          await server.close().catch(() => {});
        }
        for (const listener of reservedListeners.values()) {
          await listener.closeUnadopted();
        }
        restoreActivePluginRegistrySnapshot(original);
        await state.cleanup();
      } finally {
        healthFactory.mockRestore();
        auditFactory.mockRestore();
      }
    },
  };
}

/** Synthetic identities and stored history; server, lock, admission and retirement are real. */
export async function createGatewaySuspendedReaderFixture(
  options: { port?: number; roleName?: "admin" | "administrator" } = {},
) {
  const fixture = await createGatewayMetadataCloseFixture("suspended-reader");
  let cleanupOwner = () => fixture.cleanup();
  try {
    const sockets = new Set<WebSocket>();
    const principal = "github:microsoft.ghe.com:101";
    const missingPrincipal = "github:microsoft.ghe.com:102";
    const guestPrincipal = "github:microsoft.ghe.com:103";
    const noReadPrincipal = "github:microsoft.ghe.com:104";
    const privatePassword = "reader-fixture-private-control";
    const origin = "https://reader.example.test";
    const roleName = options.roleName ?? "admin";
    const scopes: GatewayOperatorRoleDefinition["scopes"] = [
      "operator.admin",
      "operator.read",
      "operator.write",
    ];
    const auth = {
      mode: "trusted-proxy" as const,
      password: privatePassword,
      identityScopes: { [principal]: scopes },
      trustedProxy: {
        userHeader: "x-factory-principal",
        requiredHeaders: ["x-forwarded-proto"],
        allowUsers: [principal, missingPrincipal, guestPrincipal, noReadPrincipal],
        allowLoopback: true,
      },
    };
    fixture.config.gateway = {
      auth,
      roles: {
        default: "guest",
        definitions: {
          [roleName]: { scopes, sessions: { others: "write" }, agents: ["main"] },
          guest: { scopes: ["operator.read"], sessions: { others: "none" }, agents: [] },
          noRead: { scopes: [], sessions: { others: "none" }, agents: [] },
        },
      },
      trustedProxies: ["127.0.0.1"],
      controlUi: { enabled: true, allowedOrigins: [origin], root: fixture.state.path("reader-ui") },
    };
    await fs.mkdir(fixture.state.path("reader-ui"));
    await fs.writeFile(
      fixture.state.path("reader-ui/index.html"),
      "<html>Frozen authenticated reader</html>",
    );
    fixture.state.applyEnv();
    const port = await fixture.reservePort(options.port);
    await fixture.state.writeConfig(fixture.config);
    const lock = await acquireGatewayLock({
      allowInTests: true,
      port,
      listenerMode: "supervised",
      supervisor: { kind: "external", name: "reader-fixture" },
    });
    assert(lock?.retireWriter);
    const enteredWriterJoin = createDeferredCore();
    const finishWriterJoin = createDeferredCore();
    const expireReader = vi.fn();
    let server: GatewayServer | undefined;
    let writerSettled = false;
    const host = createGatewayHostLifecycle({
      processOwner: { ownsProcessLifecycle: true, supervisor: "external" },
      isCurrent: () => true,
      isServing: () => true,
      acceptStop: () => {},
      prepareReader: (request, current) => {
        assert(server?.prepareReader);
        return server.prepareReader(request, current).then((receipt) => {
          writerSettled = true;
          return receipt;
        });
      },
      retireWriter: async () => {
        enteredWriterJoin.resolve();
        await finishWriterJoin.promise;
        await lock.retireWriter!();
      },
      retireReader: expireReader,
    });
    const headers = {
      origin,
      "x-forwarded-for": "203.0.113.35",
      "x-forwarded-proto": "https",
      "x-factory-principal": principal,
      "x-factory-github-login": "reader-fixture",
      "x-openclaw-scopes": scopes.join(","),
    };
    const open = async (
      authenticated = true,
      controlPassword?: string,
      personalPrincipal = principal,
      transport?: { url?: string; headers?: Record<string, string> },
    ) => {
      const socket = new WebSocket(transport?.url ?? `ws://127.0.0.1:${port}`, {
        headers:
          transport?.headers ??
          (controlPassword !== undefined
            ? {}
            : authenticated
              ? { ...headers, "x-factory-principal": personalPrincipal }
              : { origin }),
      });
      sockets.add(socket);
      const pending = new Map<string, ReturnType<typeof createDeferredCore<ResponseFrame>>>();
      socket.on("message", (data) => {
        const frame: unknown = JSON.parse(rawDataToString(data));
        if (Value.Check(ResponseFrameSchema, frame)) {
          pending.get(frame.id)?.resolve(frame);
          pending.delete(frame.id);
        }
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const request = (method: string, params: unknown) => {
        const id = randomUUID();
        const result = createDeferredCore<ResponseFrame>();
        pending.set(id, result);
        socket.send(JSON.stringify({ type: "req", id, method, params }));
        return result.promise;
      };
      const hello = await request("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client:
          controlPassword !== undefined
            ? { id: "cli", version: "1.0.0", platform: "test", mode: "cli" }
            : { id: "openclaw-control-ui", version: "1.0.0", platform: "test", mode: "webchat" },
        role: "operator",
        scopes,
        ...(controlPassword !== undefined ? { auth: { password: controlPassword } } : {}),
      });
      return { socket, request, hello };
    };
    const cleanup = async () => {
      finishWriterJoin.resolve();
      for (const socket of sockets) {
        socket.terminate();
      }
      try {
        try {
          await server?.close();
        } finally {
          await host.retire();
        }
      } finally {
        try {
          if (isGatewayWriterRetired() && !writerSettled) {
            await runWithGatewayWriterRetirementCleanup(() => lock.release());
          } else {
            await lock.release();
          }
        } finally {
          await fixture.cleanup();
        }
      }
    };
    cleanupOwner = cleanup;
    const stored = await lock.run(async () => {
      const profile = await ensureCanonicalFactoryGitHubProfile(principal, "Reader fixture");
      await setCanonicalUserProfileRole(profile.id, roleName);
      const avatarBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      assert((await setCanonicalUserProfileAvatar(profile.id, avatarBytes, "image/png")).ok);
      const blank = await ensureCanonicalFactoryGitHubProfile(
        "github:microsoft.ghe.com:105",
        "No uploaded image",
      );
      await ensureCanonicalFactoryGitHubProfile(guestPrincipal, "Guest fixture");
      const noRead = await ensureCanonicalFactoryGitHubProfile(noReadPrincipal, "No read access");
      await setCanonicalUserProfileRole(noRead.id, "noRead");
      server = await fixture.start(port, {
        auth,
        hostLifecycle: host.capability,
        controlUiEnabled: true,
      });
      const sessionKey = "agent:main:reader-fixture";
      const sessionId = "reader-accepted-turn";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId, updatedAt: Date.now() },
      );
      const saved = loadSessionEntry(sessionKey, { agentId: "main" });
      await appendTranscriptMessage(
        { agentId: "main", sessionKey, sessionId, storePath: saved.storePath },
        { message: { role: "user", content: "Retain this accepted turn" } },
      );
      const shortSessionId = "12345678-90ab-cdef-1234-567890abcdef";
      const shortSessionKey = `agent:main:dashboard:${shortSessionId}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: shortSessionKey },
        {
          sessionId: shortSessionId,
          updatedAt: Date.now(),
          createdActor: { type: "human", source: "profile", id: profile.id },
        },
      );
      const shortSaved = loadSessionEntry(shortSessionKey, { agentId: "main" });
      await appendTranscriptMessage(
        {
          agentId: "main",
          sessionKey: shortSessionKey,
          sessionId: shortSessionId,
          storePath: shortSaved.storePath,
        },
        { message: { role: "user", content: "Accepted cold-route history" } },
      );
      const ambiguousKey = "agent:main:dashboard:12345678-1111-2222-3333-444444444444";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: ambiguousKey },
        { sessionId: "12345678-1111-2222-3333-444444444444", updatedAt: Date.now() },
      );
      return {
        profile,
        avatarBytes,
        blank,
        sessionKey,
        sessionId,
        shortSessionId,
        shortSessionKey,
        ambiguousKey,
      };
    });
    assert(server);
    return {
      fixture,
      lock,
      server,
      host,
      port,
      principal,
      missingPrincipal,
      guestPrincipal,
      noReadPrincipal,
      privatePassword,
      origin,
      scopes,
      headers,
      open,
      enteredWriterJoin,
      finishWriterJoin,
      expireReader,
      ...stored,
      cleanup,
    };
  } catch (error) {
    await cleanupOwner();
    throw error;
  }
}
