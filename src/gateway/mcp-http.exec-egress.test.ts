import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
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

it("hands off background completion from an internal-event MCP grant to its originating session", async ({
  signal,
}) => {
  const sessionKey = "agent:probe:telegram:group:-100155462274:topic:42";
  const sessionId = "mcp-continuation-session";
  const topic = "telegram:-100155462274:topic:42";
  setRuntimeConfigSnapshot(config, config);
  await replaceSessionEntry(
    { agentId: "probe", sessionKey },
    {
      sessionId,
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({
        context: {
          channel: "telegram",
          to: topic,
          accountId: "work",
          threadId: 42,
        },
      }),
    },
  );
  const notified = createDeferred<{
    text: string;
    options: Parameters<typeof sessionEvents.enqueueSessionEventForHost>[1];
  }>();
  const receipts: ReturnType<typeof sessionEvents.enqueueSessionEventForHost>[] = [];
  const enqueue = sessionEvents.enqueueSessionEventForHost;
  const handoff = vi
    .spyOn(sessionEvents, "enqueueSessionEventForHost")
    .mockImplementation((text, options) => {
      const receipt = enqueue(text, options);
      if (options.sessionKey === sessionKey) {
        receipts.push(receipt);
        notified.resolve({ text, options });
      }
      return receipt;
    });
  try {
    const { request } = await mintExecGrant(
      "mcp-continuation",
      {
        sessionKey,
        trigger: "event",
        toolsAllow: ["exec", "process"],
        messageProvider: "telegram",
        currentChannelId: topic,
        currentThreadTs: "42",
        accountId: "work",
      },
      { command: "echo mcp-chain-ok", background: true },
    );
    const started = await request("tools/call");
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ result: { isError: false } });
    const completion = await withinTest(notified.promise, signal);
    expect(completion.text).toContain("mcp-chain-ok");
    expect(completion.options).toMatchObject({
      agentId: "probe",
      sessionKey,
      source: "exec",
      deliveryContext: {
        channel: "telegram",
        to: topic,
        accountId: "work",
        threadId: "42",
      },
      expectedTarget: { agentId: "probe", sessionKey, sessionId },
    });
    expect(receipts).toHaveLength(1);
  } finally {
    for (const receipt of receipts) {
      receipt.cancel();
    }
    await Promise.all(receipts.map((receipt) => receipt.settled));
    handoff.mockRestore();
  }
});
