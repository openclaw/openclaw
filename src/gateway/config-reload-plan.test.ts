import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import type { OpenClawPluginDefinition } from "../plugins/plugin-definition.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
  resolveConfigReloadMetadata,
} from "./config-reload-plan.js";

describe("Gateway core reload policy", () => {
  beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
  afterEach(() => resetPluginRuntimeStateForTest());

  it.each(["memory-core", "none"])(
    "reloads the selected memory index service for provider changes (memory slot: %s)",
    async (memorySlot) => {
      const { default: memory } = await loadBundledPluginFacade<{
        default: OpenClawPluginDefinition;
      }>({ pluginId: "memory-core", artifactBasename: "index.ts" });
      if (!memory.register) {
        throw new Error("Memory plugin must expose its registration entry point");
      }
      const registry = createEmptyPluginRegistry();
      memory.register(
        createTestPluginApi({
          id: "memory-core",
          config: { plugins: { slots: { memory: memorySlot } } },
          registerService(service) {
            registry.services.push({
              pluginId: "memory-core",
              source: "test",
              origin: "bundled",
              id: service.id,
              service,
            });
          },
        }),
      );
      setActivePluginRegistry(registry);
      for (const path of [
        "models.providers.ollama.baseUrl",
        "models.providers.ollama.apiKey",
        "models.providers.ollama.headers",
        "models.providers.ollama",
        "models.providers",
      ]) {
        const plan = buildGatewayReloadPlan([path]);
        expect(plan.restartGateway, path).toBe(false);
        expect(plan.reloadPlugins, path).toBe(false);
        expect(plan.restartServices, path).toEqual(
          new Set(memorySlot === "memory-core" ? ["memory-core-index"] : []),
        );
      }
      expect(buildGatewayReloadPlan(["models.mode"]).restartServices).toEqual(new Set());
    },
  );

  it.each([
    { before: ["Root", "Ada"], after: ["Ada"], key: "Root", canonical: true, target: "root" },
    { before: ["Root"], after: ["Root"], key: "Root", canonical: true, target: "root" },
    { before: ["Root"], after: [], key: "Root", canonical: false, target: "Root" },
    { before: ["Root"], after: ["root"], key: "Root", canonical: false, target: null },
    { before: ["Root", "root"], after: ["root"], key: "Root", canonical: false, target: null },
    { before: ["Default"], after: [], key: "Default", canonical: true, target: null },
    { before: ["team.ops"], after: [], key: "team.ops", canonical: true, target: null },
    {
      before: ["team", "team.ops"],
      after: ["team"],
      key: "team.ops",
      canonical: true,
      target: null,
    },
  ])(
    "uses the listed runtime identity for $key: $before -> $after (canonical=$canonical)",
    ({ before, after, key, canonical, target }) => {
      const config = (ids: string[]): OpenClawConfig => ({
        channels: { mattermost: { accounts: Object.fromEntries(ids.map((id) => [id, {}])) } },
      });
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({ id: "mattermost" }),
        reload: { configPrefixes: ["channels.mattermost"], accountScopedRestart: true },
        config: {
          listAccountIds: (cfg) => {
            const ids = Object.keys(cfg.channels?.mattermost?.accounts ?? {});
            return canonical ? ids.map(normalizeAccountId) : ids;
          },
          resolveAccount: () => ({}),
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "mattermost", plugin, source: "test" }]),
      );
      const plan = buildGatewayReloadPlan([`channels.mattermost.accounts.${key}`], {
        previousConfig: config(before),
        candidateConfig: config(after),
      });
      expect(plan.restartChannels).toEqual(new Set(target === null ? ["mattermost"] : []));
      expect(plan.restartChannelAccounts).toEqual(
        target === null ? new Map() : new Map([["mattermost", new Set([target])]]),
      );
    },
  );

  it.each([
    { change: "allow", mode: "noop" },
    { change: "remove-policy", mode: "noop" },
    { change: "default", mode: "hot" },
    { change: "github-assignment", mode: "hot" },
    { change: "remove-role", mode: "hot" },
    { change: "mixed-role", mode: "hot" },
    { change: "mixed-gateway", mode: "restart" },
    { change: "effective-scopes", mode: "hot" },
    { change: "authored-scopes", mode: "hot" },
    { change: "missing-effective", mode: "hot" },
    { change: "missing-authored", mode: "hot" },
  ])("preserves reload ownership for role change: $change", ({ change, mode }) => {
    const roleName = "reader.modelPolicy.allow";
    const previous: OpenClawConfig = {
      gateway: {
        roles: {
          default: roleName,
          definitions: {
            [roleName]: {
              agents: "*",
              scopes: ["operator.write"],
              sessions: { others: "view" },
              modelPolicy: { allow: ["fixture/a", "fixture/b"] },
            },
            staff: { agents: "*", scopes: ["operator.admin"], sessions: { others: "write" } },
          },
        },
      },
    };
    const candidate = structuredClone(previous);
    const roles = candidate.gateway!.roles!;
    const role = roles.definitions[roleName]!;
    switch (change) {
      case "allow":
        role.modelPolicy = { allow: ["fixture/b"] };
        break;
      case "remove-policy":
        delete role.modelPolicy;
        break;
      case "default":
        roles.default = "staff";
        break;
      case "github-assignment":
        roles.assignments = { byGithubLogin: { "release-operator": "staff" } };
        break;
      case "remove-role":
        delete roles.definitions.staff;
        break;
      case "mixed-role":
        role.modelPolicy!.deny = ["fixture/a"];
        roles.definitions.staff!.agents = [];
        break;
      case "mixed-gateway":
        role.modelPolicy!.deny = ["fixture/a"];
        candidate.gateway!.port = 18790;
        break;
      case "effective-scopes":
      case "authored-scopes":
        role.modelPolicy!.deny = ["fixture/a"];
        role.scopes = ["operator.read"];
        break;
      case "missing-effective":
      case "missing-authored":
        role.modelPolicy!.deny = ["fixture/a"];
        break;
    }
    const previousCompareConfig = structuredClone(previous);
    const candidateCompareConfig = structuredClone(candidate);
    if (change === "effective-scopes") {
      candidateCompareConfig.gateway!.roles!.definitions[roleName]!.scopes = ["operator.write"];
    } else if (change === "authored-scopes") {
      role.scopes = ["operator.write"];
    }
    const changedPaths = diffGatewayReloadPaths(
      previousCompareConfig,
      candidateCompareConfig,
      listConfigReloadRefinementPrefixes(),
    );
    const plan = buildGatewayReloadPlan(changedPaths, {
      previousConfig: change === "missing-effective" ? undefined : previous,
      candidateConfig: candidate,
      previousCompareConfig: change === "missing-authored" ? undefined : previousCompareConfig,
      candidateCompareConfig,
    });
    expect(plan.restartGateway).toBe(mode === "restart");
    expect(isNoopGatewayReloadPlan(plan)).toBe(mode === "noop");
    if (mode === "noop") {
      expect(plan.noopPaths).toEqual(changedPaths);
    } else if (mode === "hot") {
      expect(plan.hotReasons).toEqual(changedPaths);
    }
  });

  it.each([
    ...[
      "mcp.apps.enabled",
      "gateway.auth.token",
      "gateway.bind",
      "gateway.controlUi.root",
      "browser.enabled",
      "gateway.auth.mode",
      "discovery.wideArea.domain",
      "security.unknownPolicy",
      "secrets.egressProxy.enabled",
    ].map((path) => ({ path, restart: true, heartbeat: false })),
    ...[
      "tools.codeMode.enabled",
      "gateway.controlUi.experimental.customPlugins",
      "gateway.controlUi.experimental.chatBubbles",
    ].map((path) => ({
      path,
      restart: false,
      heartbeat: false,
    })),
    { path: "agents.defaults.model", restart: false, heartbeat: true },
  ])("classifies reload path: $path", ({ path, restart, heartbeat }) => {
    const plan = buildGatewayReloadPlan([path]);
    expect(plan.restartGateway).toBe(restart);
    expect(plan.restartReasons).toEqual(restart ? [path] : []);
    expect(plan.hotReasons).toEqual(restart ? [] : [path]);
    expect(plan.restartHeartbeat).toBe(heartbeat);
    expect(resolveConfigReloadMetadata(path).kind).toBe(restart ? "restart" : "hot");
  });
});
