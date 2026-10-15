import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
  resolveConfigReloadMetadata,
} from "./config-reload-plan.js";

beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
afterEach(() => resetPluginRuntimeStateForTest());

describe("Gateway operation policy reload", () => {
  it.each([
    "gateway.auth.rateLimit.maxAttempts",
    "gateway.roles.definitions.operator.scopes",
    "gateway.trustedProxies",
    "gateway.allowRealIpFallback",
    "gateway.auth.allowTailscale",
    "gateway.auth.identityScopes",
    "gateway.auth.trustedProxy.userHeader",
    "discovery.mdns.mode",
    "gateway.http.securityHeaders.strictTransportSecurity",
    "gateway.nodes.pairing.autoApproveLocal",
    "gateway.terminal.enabled",
    "gateway.http.endpoints.chatCompletions.enabled",
    "gateway.tools.allow",
    "gateway.cliAgents.enabled",
    "gateway.uploads.enabled",
    "gateway.controlUi.enabled",
    "gateway.controlUi.environment.label",
    "gateway.controlUi.communityInvite",
    "gateway.controlUi.newSessionModelDefaults",
    "gateway.controlUi.github.token",
    "gateway.controlUi.sessionObserver",
    "gateway.controlUi.embedSandbox",
    "gateway.controlUi.allowExternalEmbedUrls",
    "gateway.controlUi.automaticallyFetchFavicons",
    "gateway.controlUi.allowedOrigins",
    "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback",
    "gateway.nodes.commands.allow",
    "gateway.nodes.pluginTools.enabled",
    "gateway.nodes.allowSkills",
    "gateway.nodes.browser.mode",
    "gateway.push.apns.relay.baseUrl",
    "mcp.apps.sandboxOrigin",
    "approvals.exec.enabled",
    "approvals.plugin.targets",
    "auth.order.openai",
    "auth.profiles.primary.mode",
    "broadcast.strategy",
    "memory.citations",
    "worktreeRoot",
    "worktreeMaxCount",
    "worktreeAcceleration",
    "desktop.host.enabled",
    "cloudWorkers.desktop",
    "security.audit.suppressions",
    "security.installPolicy",
    "diagnostics.cacheTrace.enabled",
    "acp.runtime.installCommand",
    "attachments.ttlHours",
    "update.checkOnStart",
    "update.channel",
    "update.auto.enabled",
    "telemetry.enabled",
    "telemetry.consentedAt",
  ])("hot-applies operation policy without restarting subsystems: %s", (path) => {
    const plan = buildGatewayReloadPlan([path]);

    expect(plan).toMatchObject({
      restartGateway: false,
      restartReasons: [],
      hotReasons: [path],
      noopPaths: [],
      restartCron: false,
      reloadHooks: false,
      reloadPlugins: false,
      disposeMcpRuntimes: false,
      restartChannels: new Set(),
      restartChannelAccounts: new Map(),
    });
    expect(resolveConfigReloadMetadata(path).kind).toBe("hot");
  });

  it.each(["cloudWorkers.profiles", "cloudWorkers.profiles.build.settings.machineType"])(
    "refreshes provider activation without restarting the Gateway: %s",
    (path) => {
      expect(buildGatewayReloadPlan([path])).toMatchObject({
        restartGateway: false,
        reloadPlugins: true,
        hotReasons: [path],
      });
    },
  );

  it.each([
    {
      name: "only request policies",
      config: {
        gateway: {
          tools: { deny: ["sessions_list"] },
          http: { endpoints: { responses: { enabled: true } } },
          controlUi: { environment: { label: "Test", color: "teal" }, sessionObserver: false },
          nodes: { browser: { mode: "off" }, pairing: { autoApproveLocal: false } },
          terminal: { enabled: false, shell: "/bin/sh" },
          auth: { rateLimit: { maxAttempts: 5 } },
        },
        discovery: { mdns: { mode: "off" } },
        mcp: { apps: { sandboxOrigin: "https://sandbox.example" } },
        auth: { order: { openai: ["primary"] } },
        diagnostics: { cacheTrace: { enabled: true } },
        desktop: { host: { enabled: true, managed: true, port: 5901, passwordFile: "vnc.txt" } },
        cloudWorkers: { preparedPool: { maxTotal: 2 }, desktop: true },
        worktreeAcceleration: false,
      },
      restartReasons: [],
    },
    {
      name: "request policies and startup settings",
      config: {
        gateway: {
          port: 18791,
          http: {
            endpoints: { responses: { enabled: true } },
            securityHeaders: { strictTransportSecurity: "max-age=31536000" },
          },
          controlUi: { environment: { label: "Test", color: "teal" }, basePath: "/chat" },
          nodes: { pairing: { sshVerify: false } },
        },
        mcp: { apps: { sandboxOrigin: "https://sandbox.example", sandboxPort: 18792 } },
      },
      restartReasons: ["gateway.port", "gateway.controlUi.basePath", "mcp.apps.sandboxPort"],
    },
  ] satisfies { name: string; config: OpenClawConfig; restartReasons: string[] }[])(
    "preserves $name when adding or removing Gateway config",
    ({ config, restartReasons }) => {
      for (const [previous, next] of [
        [{}, config],
        [config, {}],
      ] as const) {
        const changedPaths = diffGatewayReloadPaths(
          previous,
          next,
          listConfigReloadRefinementPrefixes(),
        );
        const plan = buildGatewayReloadPlan(changedPaths);

        expect(plan.restartReasons).toEqual(restartReasons);
        expect(plan.restartGateway).toBe(restartReasons.length > 0);
        expect(plan.hotReasons).toContain("gateway.http.endpoints");
        expect(plan.hotReasons).toContain("gateway.controlUi.environment");
      }
    },
  );
});
