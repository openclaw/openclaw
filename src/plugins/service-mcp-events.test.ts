import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { McpConnectionAuthorityError } from "../agents/mcp-connection-authority-error.js";
import type { McpConnectionAuthority } from "../agents/mcp-connection-authority.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronStoredJob } from "../cron/types.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import { createPluginServiceMcpEvents } from "./service-mcp-events.js";
import { createServiceCronHost } from "./services.test-support.js";
import type { McpServerConnectionResolved } from "./types.mcp-connection.js";

const mocks = vi.hoisted(() => ({
  entry: { sessionId: "creator-session", updatedAt: 1 } as SessionEntry | undefined,
  deny: [] as string[],
  group: vi.fn(),
  resolver: vi.fn(),
  useResolver: false,
  request: vi.fn<typeof import("../agents/mcp-event-request.js").requestMcpEvent>(),
}));
vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  listAgentIds: () => ["main"],
  resolveAgentDir: () => "/agent",
  resolveAgentWorkspaceDir: () => "/workspace",
}));
vi.mock("../agents/agent-tools.policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-tools.policy.js")>()),
  resolveEffectiveToolPolicy: () => ({ globalPolicy: { deny: mocks.deny } }),
  resolveGroupToolPolicy: mocks.group,
}));
vi.mock("../agents/sender-tool-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/sender-tool-policy.js")>()),
  resolveSenderToolPolicy: () => undefined,
}));
vi.mock("./bundle-mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bundle-mcp.js")>()),
  loadEnabledBundleMcpConfig: (): ReturnType<
    typeof import("./bundle-mcp.js").loadEnabledBundleMcpConfig
  > => ({
    config: { mcpServers: {} },
    diagnostics: [],
    pluginIdsByServer: {},
    prepareDataDirsByServer: {},
  }),
}));
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getActivePluginRegistry: () => ({
    mcpServerConnectionResolvers: mocks.useResolver
      ? [{ pluginId: "connector", resolver: { serverName: "calendar", resolve: mocks.resolver } }]
      : [],
  }),
}));
vi.mock("./runtime/gateway-request-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime/gateway-request-scope.js")>()),
  getPluginRuntimeGatewayRequestScope: () => undefined,
}));
vi.mock("../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-entry-read-runtime.js")>()),
  withSessionEntryReadOnlyInWorker: async (
    _input: unknown,
    guard: () => void,
    consume: (read: unknown) => Promise<unknown>,
  ) => {
    guard();
    return await consume({ ok: true, value: mocks.entry });
  },
}));
vi.mock("../gateway/scheduled-run-gateway-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/scheduled-run-gateway-context.js")>()),
  createScheduledGatewayRunner: () => async (run: () => Promise<unknown>) => await run(),
}));
vi.mock("../agents/mcp-event-request.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/mcp-event-request.js")>()),
  requestMcpEvent: mocks.request,
}));
vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

function resolverAuthority(authorizationId = "grant-one"): McpConnectionAuthority {
  return {
    authorizationId,
    assertCurrent: vi.fn(),
    revalidate: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

const source = { jobId: "event-job", sourceIdentity: "generation-one", serverName: "calendar" };
const signal = new AbortController().signal;
const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
const subscription = {
  name: "calendar.changed",
  arguments: { calendar: "work", nested: { b: 2, a: 1 } },
  delivery: { mode: "webhook", url: "https://callback.example/events/one", secret },
  ttlMs: 60_000,
  cursor: null,
};
const cleanups: Array<() => void> = [];
function fixture(pluginId = "mcp-events") {
  let cfg: OpenClawConfig = {
    mcp: {
      servers: { calendar: { transport: "streamable-http", url: "https://calendar.example/mcp" } },
    },
  };
  let job: CronStoredJob | undefined = {
    id: source.jobId,
    name: "Calendar",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    agentId: "main",
    sessionTarget: "isolated",
    wakeMode: "now",
    owner: { agentId: "main", sessionKey: "agent:main:discord:direct:alice", accountId: "default" },
    scheduledToolPolicy: {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:discord:direct:alice",
      ownerAccountId: "default",
    },
    toolsAllowProvenance: {
      version: 1,
      source: "authenticated-requester",
      callerOrigin: { kind: "external", channel: "discord" },
      channelRequester: { version: 1, channel: "discord", accountId: "default", senderId: "alice" },
    },
    schedule: {
      kind: "event",
      source: pluginId,
      options: { server: "calendar", name: subscription.name, arguments: subscription.arguments },
    },
    payload: { kind: "agentTurn", message: "Summarize the change", toolsAllow: [] },
    state: { sourceIdentity: source.sourceIdentity },
  };
  const lease = createPluginRuntimeCapabilityLease("test service");
  cleanups.push(lease.revoke);
  const cron = { ...createServiceCronHost(), getJob: () => job };
  const runtime = makeContextParams();
  onTestFinished(() => runtime.runtime.scheduler.stop());
  const context = createGatewayRequestContext(runtime);
  context.getRuntimeConfig = () => cfg;
  context.getGatewayMethodRegistry = undefined;
  const capability = createPluginServiceMcpEvents({
    pluginId,
    lease,
    isStopping: () => false,
    getCron: () => cron,
    resolveGatewayContext: () => context,
  });
  return {
    capability,
    lease,
    get job() {
      return job!;
    },
    get cfg() {
      return cfg;
    },
    replaceConfig(next: OpenClawConfig) {
      cfg = next;
    },
    remove() {
      job = undefined;
    },
  };
}
beforeEach(() => {
  mocks.entry = { sessionId: "creator-session", updatedAt: 1 };
  mocks.deny = [];
  mocks.useResolver = false;
  mocks.resolver.mockReset();
  mocks.group.mockReset();
  mocks.request.mockReset();
  mocks.request.mockImplementation(async (input) => {
    input.assertCurrent();
    return input.method === "events/subscribe"
      ? {
          id: "remote",
          refreshBefore: new Date(Date.now() + 60_000).toISOString(),
          cursor: null,
          truncated: false,
        }
      : {};
  });
});
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
});

describe("native MCP Events source authority", () => {
  it("serves external event plugins only for their own authored source namespace", async () => {
    const f = fixture("external-events");
    const prepared = await f.capability.prepareSource(source);
    prepared.assertCurrent();
    prepared.dispose();
    if (f.job.schedule.kind !== "event") {
      throw new Error("Missing event fixture");
    }
    f.job.schedule.source = "other-plugin";
    await expect(f.capability.prepareSource(source)).rejects.toThrow("source is no longer current");
  });
  it("resolves the saved requester without accepting caller-supplied principal fields", async () => {
    const f = fixture();
    mocks.useResolver = true;
    mocks.resolver.mockResolvedValue({
      url: "https://alice.example/mcp",
      authority: resolverAuthority(),
      headers: { Authorization: "Bearer private-fixture" },
    });
    const prepared = await f.capability.prepareSource(source);
    await prepared.request(
      "events/list",
      { requesterSenderId: "mallory", agentId: "other" },
      signal,
    );
    expect(mocks.resolver).toHaveBeenCalledWith({
      requesterSenderId: "alice",
      agentAccountId: "default",
      messageChannel: "discord",
      requireLiveAuthority: true,
    });
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        server: expect.objectContaining({ url: "https://alice.example/mcp" }),
        params: {},
      }),
    );
    expect(mocks.group).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        requireConfiguredAccount: true,
        senderId: "alice",
      }),
    );
  });
  it.each(["oauth", "resolver"])(
    "never falls back to shared credentials for a requester %s server",
    async (mode) => {
      const f = fixture();
      delete f.job.toolsAllowProvenance;
      if (mode === "oauth") {
        f.cfg.mcp!.servers!.calendar = {
          transport: "streamable-http",
          url: "https://calendar.example/mcp",
          auth: "oauth",
          oauth: { identity: "per-requester" },
        };
      } else {
        mocks.useResolver = true;
      }
      await expect(f.capability.prepareSource(source)).rejects.toThrow(
        "original authenticated requester",
      );
      expect(mocks.request).not.toHaveBeenCalled();
      expect(mocks.resolver).not.toHaveBeenCalled();
    },
  );
  it.each([
    "disabled",
    "session-server",
    "session-namespace",
    "tool-namespace",
    "no-owner",
    "account-disabled",
  ])("rejects revoked %s authority before transport", async (kind) => {
    const f = fixture();
    if (kind === "disabled") {
      const server = f.cfg.mcp?.servers?.calendar;
      if (!server) {
        throw new Error("Missing fixture MCP server");
      }
      server.enabled = false;
    }
    if (kind === "session-server") {
      mocks.entry!.toolOverrides = { mcpServers: { calendar: false } };
    }
    if (kind === "session-namespace") {
      mocks.entry!.toolOverrides = { mcpToolsDeny: { calendar: ["*"] } };
    }
    if (kind === "tool-namespace") {
      mocks.deny = ["calendar__*"];
    }
    if (kind === "account-disabled") {
      f.cfg.channels = { discord: { enabled: false } };
    }
    if (kind === "no-owner") {
      delete f.job.scheduledToolPolicy;
    }
    await expect(f.capability.prepareSource(source)).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("revalidates job ownership after a requester resolver await", async () => {
    const f = fixture();
    mocks.useResolver = true;
    const started = createDeferredCore();
    const gate = createDeferredCore<McpServerConnectionResolved>();
    mocks.resolver.mockImplementation(() => {
      started.resolve();
      return gate.promise;
    });
    const pending = f.capability.prepareSource(source);
    await started.promise;
    f.job.enabled = false;
    gate.resolve({ url: "https://alice.example/mcp", authority: resolverAuthority() });
    await expect(pending).rejects.toThrow("authority or configuration changed");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("retains source authority for callback/commit guards and disposes superseded handles", async () => {
    const f = fixture();
    const prepared = await f.capability.prepareSource(source);
    expect(prepared.principalId).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.accountId).toMatch(/^[a-f0-9]{64}$/);
    expect(() => prepared.assertCurrent()).not.toThrow();
    sessionChanges.emit({ agentId: "main", sessionKey: f.job.owner!.sessionKey! });
    expect(() => prepared.assertCurrent()).toThrow("creator session changed");
    prepared.dispose();
    await expect(prepared.request("events/list", {}, new AbortController().signal)).rejects.toThrow(
      "disposed",
    );
  });
  it("checks disposed prepared source at the last HTTP boundary, not just admission", async () => {
    const f = fixture();
    const prepared = await f.capability.prepareSource(source);
    mocks.request.mockImplementationOnce(async (input) => {
      prepared.dispose();
      input.assertCurrent();
      return {};
    });
    await expect(prepared.request("events/list", {}, new AbortController().signal)).rejects.toThrow(
      "disposed",
    );
  });
  it("retains exact cleanup across benign refresh, removal, and connector config replacement", async () => {
    const f = fixture();
    const prepared = await f.capability.prepareSource(source);
    await prepared.request("events/subscribe", subscription, signal);
    expect(isSecretValueRegisteredForRedaction(secret)).toBe(true);
    expect(isSecretValueRegisteredForRedaction(secret.slice(6))).toBe(true);
    const principalId = prepared.principalId;
    f.replaceConfig({ ...f.cfg, logging: { level: "debug" } });
    sessionChanges.emit({ agentId: "main", sessionKey: f.job.owner!.sessionKey! });
    await prepared.revalidate();
    expect(prepared.principalId).toBe(principalId);
    prepared.assertCurrent();
    await expect(
      prepared.request(
        "events/subscribe",
        {
          ...subscription,
          delivery: { ...subscription.delivery, url: "https://callback.example/events/other" },
        },
        signal,
      ),
    ).rejects.toThrow("another webhook");
    // Object order is not subscription identity.
    await prepared.request(
      "events/subscribe",
      {
        ...subscription,
        arguments: { nested: { a: 1, b: 2 }, calendar: "work" },
      },
      signal,
    );
    f.replaceConfig({
      mcp: {
        servers: {
          calendar: {
            transport: "streamable-http",
            url: "https://other.example/mcp",
          },
        },
      },
    });
    await expect(prepared.revalidate()).rejects.toMatchObject({
      code: "MCP_AUTHORIZATION_RETIRED",
    });
    const replacement = await f.capability.prepareSource(source);
    expect(replacement.principalId).not.toBe(principalId);
    expect(replacement.accountId).toBe(prepared.accountId);
    replacement.dispose();
    f.remove();
    await expect(prepared.request("events/list", {}, signal)).rejects.toThrow();
    await prepared.unsubscribe(signal);
    expect(mocks.request.mock.lastCall?.[0]).toMatchObject({
      method: "events/unsubscribe",
      server: { url: "https://calendar.example/mcp" },
      params: {
        name: subscription.name,
        delivery: { mode: "webhook", url: subscription.delivery.url },
      },
    });
    expect(mocks.request.mock.lastCall?.[0].params?.delivery).not.toHaveProperty("secret");
    await expect(prepared.unsubscribe(signal)).rejects.toThrow("no captured");
  });
  it("preserves cleanup on unknown subscribe outcome and rejects post-revocation success", async () => {
    const f = fixture();
    const prepared = await f.capability.prepareSource(source);
    mocks.request.mockImplementationOnce(async () => {
      f.job.enabled = false;
      return { id: "remote", refreshBefore: new Date(Date.now() + 60_000).toISOString() };
    });
    await expect(prepared.request("events/subscribe", subscription, signal)).rejects.toThrow(
      "authority or configuration changed",
    );
    await prepared.unsubscribe(signal);
  });
  it("fails closed for orphan cleanup and retained service revocation", async () => {
    const f = fixture();
    const prepared = await f.capability.prepareSource(source);
    await expect(prepared.unsubscribe(signal)).rejects.toThrow("finite remote lease");
    const retained = await f.capability.prepareSource(source);
    f.lease.revoke();
    await expect(retained.request("events/list", {}, signal)).rejects.toThrow();
    await expect(f.capability.prepareSource(source)).rejects.toThrow("no longer active");
  });
  it.each([0, Infinity, 3_600_001])("rejects unbounded or invalid TTL %s", async (ttlMs) => {
    const f = fixture();
    const prepared = await f.capability.prepareSource(source);
    await expect(
      prepared.request("events/subscribe", { ...subscription, ttlMs }, signal),
    ).rejects.toThrow("finite TTL");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("revalidates callbacks during subscribe and settles its late outcome before cleanup", async () => {
    const f = fixture();
    const prepared = await f.capability.prepareSource(source);
    const entered = createDeferredCore();
    const reply = createDeferredCore();
    mocks.request.mockImplementationOnce(async () => {
      await prepared.revalidate();
      entered.resolve();
      await reply.promise;
      return { refreshBefore: new Date(Date.now() + 60_000).toISOString() };
    });
    const subscribing = prepared.request("events/subscribe", subscription, signal);
    const rejected = expect(subscribing).rejects.toThrow();
    await entered.promise;
    const cleanup = prepared.unsubscribe(signal);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await expect(prepared.request("events/subscribe", subscription, signal)).rejects.toThrow();
    reply.resolve();
    await rejected;
    await cleanup;
    expect(mocks.request.mock.lastCall?.[0].method).toBe("events/unsubscribe");
  });
  it("does not borrow a replacement grant for cleanup or use revoked credentials at send", async () => {
    const f = fixture();
    mocks.useResolver = true;
    let grant = "one";
    let revoked = false;
    mocks.resolver.mockImplementation(() => ({
      url: "https://alice.example/mcp",
      authority: {
        ...resolverAuthority(grant),
        assertCurrent: () => {
          if (revoked) {
            throw new McpConnectionAuthorityError("retired");
          }
        },
      },
    }));
    const prepared = await f.capability.prepareSource(source);
    await prepared.request("events/subscribe", subscription, signal);
    grant = "two";
    await expect(prepared.unsubscribe(signal)).rejects.toMatchObject({
      code: "MCP_AUTHORIZATION_RETIRED",
    });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    grant = "one";
    mocks.request.mockImplementationOnce(async (input) => {
      revoked = true;
      input.assertCurrent();
      return {};
    });
    await expect(prepared.unsubscribe(signal)).rejects.toMatchObject({
      code: "MCP_AUTHORIZATION_RETIRED",
    });
  });
  it.each(["renew", "unsubscribe"])(
    "refuses %s at a replacement resolver endpoint under the same grant",
    async (operation) => {
      const f = fixture();
      mocks.useResolver = true;
      let url = "https://alice.example/mcp";
      mocks.resolver.mockImplementation(() => ({
        url,
        authority: resolverAuthority("same-grant"),
      }));
      const prepared = await f.capability.prepareSource(source);
      await prepared.request("events/subscribe", subscription, signal);
      url = "https://replacement.example/mcp";
      const request =
        operation === "renew"
          ? prepared.request("events/subscribe", subscription, signal)
          : prepared.unsubscribe(signal);
      await expect(request).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_RETIRED" });
      expect(mocks.request).toHaveBeenCalledTimes(1);
      prepared.dispose();
    },
  );
  it("expires exact cleanup without recreating it from a restored prepared source", async () => {
    const f = fixture();
    const prepared = await f.capability.prepareSource(source);
    await prepared.request("events/subscribe", subscription, signal);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 400_000);
    try {
      await expect(prepared.unsubscribe(signal)).rejects.toThrow("finite remote lease");
      const restored = await f.capability.prepareSource(source);
      await expect(restored.unsubscribe(signal)).rejects.toThrow("finite remote lease");
      expect(mocks.request).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });
});

it("binds callback authority to the resolver lifetime, not rotating credentials or the requester alone", async () => {
  const f = fixture();
  mocks.useResolver = true;
  let authorizationId = "grant-one";
  let credential = "fixture-first";
  const disposed = vi.fn();
  const revalidated = vi.fn();
  mocks.resolver.mockImplementation(() => {
    const captured = authorizationId;
    const assertCurrent = () => {
      if (captured !== authorizationId) {
        throw new McpConnectionAuthorityError("retired");
      }
    };
    return {
      url: "https://alice.example/mcp",
      headers: { Authorization: "Bearer " + credential },
      authority: {
        authorizationId: captured,
        assertCurrent,
        revalidate: async () => {
          revalidated();
          assertCurrent();
        },
        dispose: disposed,
      },
    };
  });
  const first = await f.capability.prepareSource(source);
  credential = "fixture-rotated";
  await first.revalidate();
  await first.request("events/list", {}, signal);
  expect(mocks.request.mock.lastCall?.[0].server).toMatchObject({
    headers: { Authorization: "Bearer fixture-rotated" },
  });
  expect(revalidated).toHaveBeenCalledOnce();
  const refreshed = await f.capability.prepareSource(source);
  expect(refreshed.principalId).toBe(first.principalId);
  authorizationId = "grant-two";
  expect(() => first.assertCurrent()).toThrow("disconnected or replaced");
  await expect(first.revalidate()).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_RETIRED" });
  const reconnected = await f.capability.prepareSource(source);
  expect(reconnected.principalId).not.toBe(first.principalId);
  expect(reconnected.accountId).toBe(first.accountId);
  first.dispose();
  refreshed.dispose();
  reconnected.dispose();
  expect(disposed).toHaveBeenCalledTimes(4);
});

it("fails closed for a credential-only resolver that cannot assert live callback authority", async () => {
  const f = fixture();
  mocks.useResolver = true;
  mocks.resolver.mockResolvedValue({ url: "https://alice.example/mcp" });
  await expect(f.capability.prepareSource(source)).rejects.toMatchObject({
    code: "MCP_AUTHORIZATION_UNAVAILABLE",
  });
  expect(mocks.request).not.toHaveBeenCalled();
});
