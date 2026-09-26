import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../commands/agent-command.test-mocks.js";
import "../commands/agent-command-attempt.test-mocks.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { resolveSandboxContext } from "../agents/sandbox/context.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { AUTH_TOKEN, createTestGatewayServer } from "./server-http.test-harness.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";

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
let cfg: OpenClawConfig;
let profileId: string;
let proxyListener: Awaited<ReturnType<typeof reserveTestPortListener>>;
let ownerListener: Awaited<ReturnType<typeof reserveTestPortListener>>;

beforeAll(async () => {
  state = await createOpenClawTestState({ label: "http-session-sandbox", scenario: "minimal" });
  cfg = {
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
          guest: {
            agents: "*",
            scopes: ["operator.read", "operator.write"],
            sessions: { others: "write" },
            sandbox: "required",
          },
          ordinary: {
            agents: "*",
            scopes: ["operator.read", "operator.write"],
            sessions: { others: "write" },
          },
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
  const context = createGatewayRequestContext(makeContextParams());
  context.resolveGatewayContext = () => context;
  const overrides = {
    openAiChatCompletionsEnabled: true,
    openResponsesEnabled: true,
    getGatewayRequestContext: () => context,
  };
  proxyListener = await reserveTestPortListener({
    offsets: [0],
    createListener: () => createTestGatewayServer({ resolvedAuth: trustedProxyAuth, overrides }),
  });
  ownerListener = await reserveTestPortListener({
    offsets: [0],
    createListener: () => createTestGatewayServer({ resolvedAuth: AUTH_TOKEN, overrides }),
  });
});

afterAll(async () => {
  for (const reservation of [proxyListener, ownerListener]) {
    if (reservation) {
      await reservation.releaseListener();
      await reservation.claim.release();
    }
  }
  await state?.cleanup();
});

beforeEach(() => {
  vi.mocked(runEmbeddedAgent).mockReset();
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

function reportRuntimeIsolation() {
  vi.mocked(runEmbeddedAgent).mockImplementation(async (params) => {
    const runtime = resolveSandboxRuntimeStatus({
      cfg: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
    return {
      payloads: [{ text: runtime.sandboxed ? "sandbox execution" : "host execution" }],
      meta: { durationMs: 0 },
    };
  });
}

describe.each(endpointCases)("$name session sandbox boundary", (endpoint) => {
  it("persists the verified creator's sandbox requirement before the first runtime", async () => {
    const sessionKey = `agent:main:http-${endpoint.key}-fresh`;
    reportRuntimeIsolation();

    const response = await post({ endpoint, sessionKey });

    expect(response.status, response.body).toBe(200);
    expect(response.body).toContain("sandbox execution");
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })).toMatchObject({
      sandbox: "required",
      createdActor: { type: "human", source: "profile", id: profileId },
    });
  });

  it("rejects an existing unsandboxed session before executing its runtime", async () => {
    const sessionKey = `agent:main:http-${endpoint.key}-host`;
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: `http-${endpoint.key}-host`,
        updatedAt: Date.now(),
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: profileId },
      },
    );
    reportRuntimeIsolation();

    const response = await post({ endpoint, sessionKey });

    expect(response.status, response.body).toBe(403);
    expect(response.body).toMatch(/sandbox/i);
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })?.sandbox).toBeUndefined();
  });

  it.each([false, true])(
    "preserves inherited sandboxing for ordinary callers (owner=%s)",
    async (owner) => {
      const sessionKey = `agent:main:http-${endpoint.key}-ordinary-${owner}`;
      reportRuntimeIsolation();

      const response = await post({ endpoint, sessionKey, email: "ordinary@example.test", owner });

      expect(response.status, response.body).toBe(200);
      expect(response.body).toContain("host execution");
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })?.sandbox).toBeUndefined();
    },
  );

  it("fails closed when the required sandbox cannot be provisioned", async () => {
    const sessionKey = `agent:main:http-${endpoint.key}-unavailable`;
    const executeHostTool = vi.fn();
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
      return { payloads: [{ text: "execution started" }], meta: { durationMs: 0 } };
    });

    const response = await post({ endpoint, sessionKey });

    expect(response.status, response.body).toBe(500);
    expect(executeHostTool).not.toHaveBeenCalled();
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })?.sandbox).toBe("required");
  });
});
