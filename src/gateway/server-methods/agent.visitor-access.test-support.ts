import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { expectDefined, isRecord } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginStateKeyedStore } from "../../plugin-state/plugin-state-store.js";
import { activatePluginRegistry } from "../../plugins/loader-shared.js";
import { clearActivePluginRegistry } from "../../plugins/runtime.js";
import {
  startPluginServices,
  type PluginServicesHandle,
} from "../../plugins/services.test-support.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createVisitorAccessPluginConfig } from "../../test-utils/visitor-access-config.test-support.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../methods/registry.js";
import { ADMIN_SCOPE, SESSION_WRITE_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import { loadGatewayPlugins } from "../server-plugins.js";
import { agentHandlers } from "./agent.js";
import { toolsInvokeHandlers } from "./tools-invoke.js";
import type { GatewayContextResolver, GatewayRequestContext } from "./types.js";
import { usersHandlers } from "./users.js";

export type Grant = { grantId?: string; createdAt: number; expiresAt: number };

export const visitorTestStateOptions = {
  label: "visitor-admitted-caller",
  env: {
    OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../../extensions/", import.meta.url)),
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
  },
};

export function createVisitorGatewayConfig(workspaceDir: string): OpenClawConfig {
  return {
    agents: { defaults: { workspace: workspaceDir }, entries: { main: {} } },
    gateway: {
      controlUi: { github: { token: "synthetic-visitor-github-token" } },
      roles: {
        default: "guest",
        definitions: {
          guest: {
            accessPolicyPlugin: "visitor-access",
            sessions: { others: "view" },
            agents: ["main"],
            scopes: [SESSION_WRITE_SCOPE],
            sandbox: "required",
            modelPolicy: {},
          },
          admin: { sessions: { others: "write" }, agents: ["main"], scopes: [ADMIN_SCOPE] },
          writer: { sessions: { others: "write" }, agents: ["main"], scopes: [WRITE_SCOPE] },
        },
      },
    },
    tools: { allow: ["visitor_invite"] },
    plugins: createVisitorAccessPluginConfig("test-account", "test-app", "test-token"),
  };
}

export function createVisitorGrantStore(env: NodeJS.ProcessEnv) {
  return createPluginStateKeyedStore<Grant>("visitor-access", {
    namespace: "visitor-grants",
    maxEntries: 500,
    overflowPolicy: "reject-new",
    env,
  });
}

export function createAccessPolicyTransport(initialEmails: readonly string[] = []) {
  const policiesPath = "/client/v4/accounts/test-account/access/apps/test-app/policies";
  let targets: Array<string | number> = [...initialEmails];
  const writes: string[] = [];
  const response = (result: unknown) => Response.json({ success: true, result });
  const policy = () => ({
    id: "visitors",
    name: "Visitors (openclaw-managed)",
    decision: "allow",
    include: targets.map((target) =>
      typeof target === "string"
        ? { email: { email: target } }
        : {
            oidc: {
              identity_provider_id: "test-oidc",
              claim_name: "github_id",
              claim_value: String(target),
            },
          },
    ),
  });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    if (url.href === "https://api.github.com/users/fresh-account" && method === "GET") {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer synthetic-visitor-github-token",
      );
      return Response.json({ id: 42, login: "fresh-account", email: null });
    }
    const collection = url.pathname === policiesPath;
    assert(
      url.origin === "https://api.cloudflare.com" &&
        (collection || url.pathname === `${policiesPath}/visitors`),
      "Unexpected provider request in visitor authority probe",
    );
    if (method === "GET") {
      return response(collection ? (targets.length ? [policy()] : []) : policy());
    }
    const bodyText = init?.body;
    assert(
      ((collection && method === "POST") || (!collection && method === "PUT")) &&
        typeof bodyText === "string",
      "Unexpected visitor policy mutation",
    );
    const body: unknown = JSON.parse(bodyText);
    assert(isRecord(body) && Array.isArray(body.include), "Expected an email policy");
    targets = body.include.map((rule: unknown) => {
      if (
        isRecord(rule) &&
        isRecord(rule.oidc) &&
        rule.oidc.identity_provider_id === "test-oidc" &&
        rule.oidc.claim_name === "github_id" &&
        rule.oidc.claim_value === "42"
      ) {
        return 42;
      }
      assert(
        isRecord(rule) && isRecord(rule.email) && typeof rule.email.email === "string",
        "Expected an email policy rule",
      );
      return rule.email.email;
    });
    writes.push(method);
    return response(policy());
  });
  return { fetcher, writes, emails: () => targets.filter((target) => typeof target === "string") };
}

export async function startVisitorGateway({
  config,
  state: { workspaceDir, env },
  context,
  resolveGatewayContext,
}: {
  config: OpenClawConfig;
  state: OpenClawTestState;
  context: GatewayRequestContext;
  resolveGatewayContext: GatewayContextResolver;
}) {
  const handlers = {
    agent: expectDefined(agentHandlers.agent, "agent handler missing"),
    "tools.invoke": expectDefined(toolsInvokeHandlers["tools.invoke"], "tools.invoke missing"),
    "users.list": expectDefined(usersHandlers["users.list"], "users.list handler missing"),
  };
  const loaded = await loadGatewayPlugins({
    cfg: config,
    autoEnabledReasons: {},
    workspaceDir,
    env,
    coreGatewayHandlers: handlers,
    baseMethods: Object.keys(handlers),
    pluginIds: ["visitor-access"],
    resolveGatewayContext,
    loadIntent: "startup",
  });
  const registry = loaded.pluginRegistry;
  const catalog = await prepareUserProfileCatalog();
  let services: PluginServicesHandle | undefined;
  const stop = async () => {
    try {
      const stopped = await services?.stop({ strict: true });
      if (stopped) {
        expect(stopped.errors).toEqual([]);
      }
    } finally {
      catalog.release();
      loaded.retireGatewayRuntimeBindings();
      await clearActivePluginRegistry(registry);
    }
  };
  try {
    const methods = createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors(handlers),
      registry,
    );
    context.getGatewayMethodRegistry = () => methods;
    activatePluginRegistry(registry, null, "gateway-bindable", workspaceDir);
    expect(registry.plugins.find(({ id }) => id === "visitor-access")).toMatchObject({
      origin: "bundled",
      status: "loaded",
    });
    expect(registry.tools.find(({ names }) => names.includes("visitor_invite"))).toHaveProperty(
      "contextVersion",
      2,
    );
    await startPluginServices({
      registry,
      config,
      workspaceDir,
      throwOnStartError: true,
      onHandle: (handle) => {
        services = handle;
      },
    });
    return { methods, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
