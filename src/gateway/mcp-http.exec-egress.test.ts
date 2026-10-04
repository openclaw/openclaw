import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { peekSystemEventEntries } from "../infra/system-events.js";
import {
  startSecretEgressProxyServer,
  type SecretEgressProxyHandle,
} from "../secrets/egress-proxy/proxy-server.js";
import {
  clearSecretEgressProxy,
  publishSecretEgressProxy,
} from "../secrets/egress-proxy/registry.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
  type McpLoopbackRequestContext,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

let state: OpenClawTestState;
let proxy: SecretEgressProxyHandle;
let config: OpenClawConfig;
const admissions: PreparedAgentRunAdmission[] = [];
const grants: string[] = [];

beforeAll(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-mcp-exec-egress-",
    layout: "state-only",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_EXEC_SHELL_SNAPSHOT: "0" },
  });
  config = {
    agents: {
      defaults: { workspace: state.workspaceDir, skipBootstrap: true },
      entries: { probe: { workspace: state.workspaceDir } },
    },
    plugins: { enabled: false },
    tools: {
      allow: ["exec", "process"],
      exec: { host: "gateway", security: "full", ask: "off" },
    },
    secrets: { egressProxy: { enabled: true } },
  };
  await state.writeConfig(config);
  proxy = await startSecretEgressProxyServer({
    caDir: state.path("proxy-ca"),
    allowedHosts: [],
    onAudit: () => {},
  });
  publishSecretEgressProxy(proxy);
  await ensureMcpLoopbackServer();
});

afterAll(async () => {
  for (const token of grants) {
    revokeMcpLoopbackClientGrant(token);
  }
  for (const admission of admissions) {
    admission.close();
  }
  await closeMcpLoopbackServer();
  if (proxy) {
    clearSecretEgressProxy(proxy);
    await proxy.stop();
  }
  await state?.cleanup();
});

async function mintExecGrant(
  runId: string,
  turn: Partial<McpLoopbackRequestContext> = { trigger: "cron" },
  args: Record<string, unknown> = { command: "echo mcp-egress-ok", yieldMs: 10000 },
) {
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("Expected the isolated MCP runtime");
  }
  const admission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId: "probe",
      ingress: { kind: "schedule", boundary: "cron.agent", state: "present" },
    },
  });
  admissions.push(admission);
  const admittedRunContext = await admission.admit("gateway");
  const grant = mintMcpLoopbackClientGrant({
    runtimeOwnerToken: runtime.ownerToken,
    admittedRunContext,
    context: {
      sessionKey: turn.sessionKey ?? "agent:probe:cron:mcp-egress",
      agentId: "probe",
      runId,
      workspaceDir: state.workspaceDir,
      cwd: state.workspaceDir,
      senderIsOwner: true,
      ...turn,
      toolsAllow: turn.toolsAllow ?? ["exec"],
    },
  });
  grants.push(grant.token);
  const captureKey = "capture-" + runId;
  expect(
    activateMcpLoopbackClientGrantCapture({
      token: grant.token,
      runtimeOwnerToken: runtime.ownerToken,
      captureKey,
    }),
  ).not.toBe(false);
  const request = async (method: "tools/list" | "tools/call") =>
    fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.token}`,
        "content-type": "application/json",
        "x-openclaw-cli-capture-key": captureKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(method === "tools/call"
          ? {
              params: {
                name: "exec",
                arguments: args,
              },
            }
          : {}),
      }),
    });
  return { token: grant.token, admission, request };
}

it("executes egress-enabled commands through cached CLI grants and rejects a retired grant", async () => {
  const first = await mintExecGrant("mcp-egress-first");
  const listed = await first.request("tools/list");
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({ result: { tools: [{ name: "exec" }] } });
  // tools/list constructed and cached the tool before this HTTP invocation.
  const executed = await first.request("tools/call");
  expect(executed.status).toBe(200);
  expect(await executed.json()).toMatchObject({
    result: {
      isError: false,
      content: [expect.objectContaining({ text: expect.stringContaining("mcp-egress-ok") })],
    },
  });
  first.admission.close();
  const retired = await first.request("tools/call");
  expect(retired.status).toBe(401);
  await retired.body?.cancel();

  // A later admitted run in the same session must remain independently usable.
  const next = await mintExecGrant("mcp-egress-next");
  const later = await next.request("tools/call");
  expect(later.status).toBe(200);
  expect(await later.json()).toMatchObject({
    result: {
      isError: false,
      content: [expect.objectContaining({ text: expect.stringContaining("mcp-egress-ok") })],
    },
  });
});

it("marks a command started by a conversation's completion turn as the conversation's own", async () => {
  const sessionKey = "agent:probe:telegram:group:-100155462274:topic:42";
  const { request } = await mintExecGrant(
    "mcp-continuation",
    {
      sessionKey,
      trigger: "heartbeat",
      continuesConversation: true,
      toolsAllow: ["exec", "process"],
      messageProvider: "telegram",
      currentChannelId: "telegram:-100155462274:topic:42",
      currentThreadTs: "42",
    },
    { command: "echo mcp-chain-ok", background: true },
  );
  const started = await request("tools/call");
  expect(started.status).toBe(200);
  await started.body?.cancel();

  await vi.waitFor(
    () =>
      expect(peekSystemEventEntries(sessionKey)).toEqual([
        expect.objectContaining({
          text: expect.stringContaining("mcp-chain-ok"),
          fromConversationTurn: true,
        }),
      ]),
    { timeout: 10_000 },
  );
});
