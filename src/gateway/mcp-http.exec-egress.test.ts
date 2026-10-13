import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { waitForExecScope } from "../agents/bash-process-registry.js";
import type { dispatchInboundMessageWithRoutedChannelDispatcher } from "../auto-reply/dispatch.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { drainSystemEvents, peekSystemEventEntries } from "../infra/system-events.js";
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

// mock-isolation: Keep completion admission deferred while the real process and egress owners settle.
vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: vi.fn<
    typeof dispatchInboundMessageWithRoutedChannelDispatcher
  >(async ({ replyOptions }) => {
    const lifecycle = expectDefined(replyOptions?.turnAdoptionLifecycle, "completion lifecycle");
    const signal = expectDefined(lifecycle.abortSignal, "completion cancellation");
    lifecycle.onDeferred?.();
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      try {
        lifecycle.onAbandoned?.();
      } finally {
        lifecycle.onSettled?.();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    return {
      deferredToActiveRun: "followup",
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    };
  }),
}));

let state: OpenClawTestState;
let proxy: SecretEgressProxyHandle;
let config: OpenClawConfig;
const admissions: PreparedAgentRunAdmission[] = [];
const grants: string[] = [];
const completionSessionKey = "agent:probe:telegram:group:-100155462274:topic:42";
const completions: sessionEvents.SessionEventReceipt[] = [];

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
  setRuntimeConfigSnapshot(config);
  await replaceSessionEntry(
    { agentId: "probe", sessionKey: completionSessionKey },
    { sessionId: "mcp-origin", lifecycleRevision: "mcp-origin-revision", updatedAt: Date.now() },
  );
  const enqueue = sessionEvents.enqueueSessionEventForHost;
  vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockImplementation((...args) => {
    const receipt = enqueue(...args);
    completions.push(receipt);
    return receipt;
  });
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
  await waitForExecScope(completionSessionKey);
  drainSystemEvents(completionSessionKey);
  await Promise.all(completions.splice(0).map((receipt) => receipt.settled));
  await closeMcpLoopbackServer();
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
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

it("routes a command started by a conversation's completion turn back to that conversation", async () => {
  const sessionKey = completionSessionKey;
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
  await expect(started.json()).resolves.toMatchObject({
    result: {
      isError: false,
      content: [
        expect.objectContaining({ text: expect.stringContaining("Command still running") }),
      ],
    },
  });

  await waitForExecScope(sessionKey);
  const receipt = expectDefined(completions[0], "conversation completion receipt");
  await expect(receipt.accepted).resolves.toEqual({ ok: true });
  expect(sessionEvents.enqueueSessionEventForHost).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("mcp-chain-ok"),
    expect.objectContaining({
      agentId: "probe",
      sessionKey,
      source: "exec",
      expectedTarget: expect.objectContaining({ sessionId: "mcp-origin", sessionKey }),
    }),
  );
  expect(peekSystemEventEntries(sessionKey)).toEqual([
    expect.objectContaining({
      id: receipt.id,
      text: expect.stringContaining("mcp-chain-ok"),
      deliveryContext: expect.objectContaining({
        channel: "telegram",
        to: "telegram:-100155462274:topic:42",
        threadId: "42",
      }),
    }),
  ]);
});
