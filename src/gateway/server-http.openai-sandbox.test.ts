import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../commands/agent-command.test-mocks.js";
import "../commands/agent-command-attempt.test-mocks.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { resolveSandboxContext } from "../agents/sandbox/context.js";
import { resolveSandboxRuntimeStatusAsync } from "../agents/sandbox/runtime-status.js";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { AUTH_TOKEN, createTestGatewayServer } from "./server-http.test-harness.js";

// The command and session owners are real; only model/provider execution is replaced.
vi.mock("../agents/agent-runtime-config.js", () => ({
  resolveAgentRuntimeConfig: async () => getRuntimeConfig(),
}));

const trustedProxyAuth: ResolvedGatewayAuth = {
  mode: "trusted-proxy",
  allowTailscale: false,
  trustedProxy: {
    userHeader: "x-forwarded-user",
    requiredHeaders: ["x-forwarded-proto"],
    allowLoopback: true,
  },
};

const endpointCases = [
  { name: "chat completions", path: "/v1/chat/completions", key: "chat" },
  { name: "responses", path: "/v1/responses", key: "responses" },
] as const;

let state: OpenClawTestState;
let profileId: string;
let proxyListener: Awaited<ReturnType<typeof reserveTestPortListener>>;
let ownerListener: Awaited<ReturnType<typeof reserveTestPortListener>>;
let releaseProfileCatalog: (() => void) | undefined;

beforeAll(async () => {
  state = await createOpenClawTestState({
    label: "http-session-sandbox",
    scenario: "minimal",
    prepareProfileCatalog: true,
  });
  const ordinaryRole: GatewayOperatorRoleDefinition = {
    agents: "*" as const,
    scopes: ["operator.read", "operator.write"],
    sessions: { others: "write" as const },
  };
  const cfg: OpenClawConfig = {
    agents: {
      entries: { main: {} },
      defaults: {
        workspace: state.workspaceDir,
        model: { primary: "anthropic/claude-opus-4-6" },
        thinkingDefault: "off",
        skipBootstrap: true,
        sandbox: { mode: "off", backend: "unavailable-http-fixture" },
      },
    },
    plugins: { enabled: false },
    gateway: {
      auth: trustedProxyAuth,
      trustedProxies: ["127.0.0.1"],
      roles: {
        default: "guest",
        definitions: {
          guest: { ...ordinaryRole, sandbox: "required" },
          ordinary: ordinaryRole,
        },
      },
    },
  };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg, cfg);
  setActivePluginRegistry(createEmptyPluginRegistry());
  profileId = ensureProfileForEmail("sandbox-guest@example.test").id;
  const ordinary = ensureProfileForEmail("ordinary@example.test");
  setUserProfileRole(ordinary.id, "ordinary");
  releaseProfileCatalog = (await prepareUserProfileCatalog()).release;
  const overrides = {
    openAiChatCompletionsEnabled: true,
    openResponsesEnabled: true,
  };
  const listen = (resolvedAuth: ResolvedGatewayAuth) =>
    reserveTestPortListener({
      offsets: [0],
      createListener: () => createTestGatewayServer({ resolvedAuth, overrides }),
    });
  proxyListener = await listen(trustedProxyAuth);
  ownerListener = await listen(AUTH_TOKEN);
});

afterAll(async () => {
  for (const reservation of [proxyListener, ownerListener]) {
    if (reservation) {
      await reservation.releaseListener();
      await reservation.claim.release();
    }
  }
  releaseProfileCatalog?.();
  await state?.cleanup();
});

function result(text: string) {
  return { payloads: [{ text }], meta: { durationMs: 0 } };
}

beforeEach(() => {
  vi.mocked(runEmbeddedAgent).mockReset();
  vi.mocked(runEmbeddedAgent).mockImplementation(async (params) => {
    const runtime = await resolveSandboxRuntimeStatusAsync({
      cfg: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
    return result(runtime.sandboxed ? "sandbox execution" : "host execution");
  });
});

async function post(params: {
  endpoint: (typeof endpointCases)[number];
  sessionKey: string;
  email?: string;
  owner?: boolean;
}) {
  const body = JSON.stringify({
    model: "openclaw/main",
    ...(params.endpoint.key === "chat"
      ? { messages: [{ role: "user", content: "Report execution isolation" }] }
      : { input: "Report execution isolation" }),
  });
  const port = (params.owner ? ownerListener : proxyListener).claim.port;
  const response = await fetch(`http://127.0.0.1:${port}${params.endpoint.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-scopes": "operator.write",
      "x-openclaw-session-key": params.sessionKey,
      ...(params.owner
        ? { authorization: "Bearer test-token" }
        : {
            "x-forwarded-for": "198.51.100.42",
            "x-forwarded-proto": "https",
            "x-forwarded-user": params.email ?? "sandbox-guest@example.test",
          }),
    },
    body,
  });
  return { status: response.status, body: await response.text() };
}

describe.each(endpointCases)("$name session sandbox boundary", (endpoint) => {
  it.each([
    { caller: "required", email: "sandbox-guest@example.test", owner: false, required: true },
    { caller: "ordinary", email: "ordinary@example.test", owner: false, required: false },
    { caller: "owner", email: "ordinary@example.test", owner: true, required: false },
  ])(
    "persists the $caller creator's sandbox policy before execution",
    async ({ caller, email, owner, required }) => {
      const sessionKey = `agent:main:http-${endpoint.key}-${caller}`;
      const response = await post({ endpoint, sessionKey, email, owner });
      expect(response.status, response.body).toBe(200);
      expect(response.body).toContain(required ? "sandbox execution" : "host execution");
      const entry = loadSessionEntryReadOnly({ agentId: "main", sessionKey });
      if (required) {
        expect(entry).toMatchObject({
          sandbox: "required",
          createdActor: { type: "human", source: "profile", id: profileId },
        });
      } else {
        expect(entry?.sandbox).toBeUndefined();
      }
    },
  );

  it.each(["host", "unavailable"] as const)("fails closed for %s sandbox", async (kind) => {
    const sessionKey = `agent:main:http-${endpoint.key}-${kind}`;
    const executeHostTool = vi.fn();
    if (kind === "host") {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: `http-${endpoint.key}-host`,
          updatedAt: Date.now(),
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: profileId },
        },
      );
    } else {
      vi.mocked(runEmbeddedAgent).mockImplementation(async (params) => {
        const sandbox = await resolveSandboxContext({
          config: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
        });
        if (!sandbox) {
          executeHostTool();
        }
        return result("execution started");
      });
    }
    const response = await post({ endpoint, sessionKey });
    expect(response.status, response.body).toBe(kind === "host" ? 403 : 500);
    if (kind === "host") {
      expect(response.body).toMatch(/sandbox/i);
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    }
    expect(executeHostTool).not.toHaveBeenCalled();
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })?.sandbox).toBe(
      kind === "host" ? undefined : "required",
    );
  });
});
