import { fileURLToPath } from "node:url";
import { expectDefined, isRecord } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginStateKeyedStore } from "../../plugin-state/plugin-state-store.js";
import { activatePluginRegistry } from "../../plugins/loader-shared.js";
import { clearActivePluginRegistry } from "../../plugins/runtime.js";
import { startPluginServices, type PluginServicesHandle } from "../../plugins/services.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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

export type Grant = { createdAt: number; expiresAt: number };

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
    agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main" }] },
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "view" },
            agents: ["main"],
            scopes: [SESSION_WRITE_SCOPE],
            sandbox: "required",
          },
          admin: { sessions: { others: "write" }, agents: ["main"], scopes: [ADMIN_SCOPE] },
          writer: { sessions: { others: "write" }, agents: ["main"], scopes: [WRITE_SCOPE] },
        },
      },
    },
    tools: { allow: ["visitor_invite"] },
    plugins: {
      allow: ["visitor-access"],
      slots: { memory: "none" },
      entries: {
        "visitor-access": {
          enabled: true,
          config: {
            accountId: "test-account",
            appId: "test-app",
            apiToken: "synthetic-visitor-token",
          },
        },
      },
    },
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
  let emails = [...initialEmails];
  const writes: string[] = [];
  const policy = () => ({
    id: "visitors",
    name: "Visitors (openclaw-managed)",
    decision: "allow",
    include: emails.map((email) => ({ email: { email } })),
  });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const collection = url.pathname === policiesPath;
    if (
      url.origin !== "https://api.cloudflare.com" ||
      (!collection && url.pathname !== `${policiesPath}/visitors`)
    ) {
      throw new Error("Unexpected provider request in visitor authority probe");
    }
    if (method === "GET") {
      return Response.json({
        success: true,
        result: collection ? (emails.length ? [policy()] : []) : policy(),
      });
    }
    const bodyText = init?.body;
    if (
      !((collection && method === "POST") || (!collection && method === "PUT")) ||
      typeof bodyText !== "string"
    ) {
      throw new Error("Unexpected visitor policy mutation");
    }
    const body: unknown = JSON.parse(bodyText);
    if (!isRecord(body) || !Array.isArray(body.include)) {
      throw new Error("Expected an email policy");
    }
    emails = body.include.map((rule: unknown) => {
      if (!isRecord(rule) || !isRecord(rule.email) || typeof rule.email.email !== "string") {
        throw new Error("Expected an email policy rule");
      }
      return rule.email.email;
    });
    writes.push(method);
    return Response.json({ success: true, result: policy() });
  });
  return { fetcher, writes, emails: () => emails };
}

export async function startVisitorGateway({
  config,
  state,
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
    "tools.invoke": expectDefined(
      toolsInvokeHandlers["tools.invoke"],
      "tools.invoke handler missing",
    ),
    "users.list": expectDefined(usersHandlers["users.list"], "users.list handler missing"),
  };
  const loaded = loadGatewayPlugins({
    cfg: config,
    autoEnabledReasons: {},
    workspaceDir: state.workspaceDir,
    env: state.env,
    log: { ...context.logGateway, debug: vi.fn() },
    coreGatewayHandlers: handlers,
    baseMethods: Object.keys(handlers),
    pluginIds: ["visitor-access"],
    resolveGatewayContext,
    loadIntent: "startup",
  });
  const registry = loaded.pluginRegistry;
  let services: PluginServicesHandle | undefined;
  const stop = async () => {
    try {
      const stopped = await services?.stop({ strict: true });
      if (stopped) {
        expect(stopped.errors).toEqual([]);
      }
    } finally {
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
    activatePluginRegistry(registry, null, "gateway-bindable", state.workspaceDir);
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
      workspaceDir: state.workspaceDir,
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
