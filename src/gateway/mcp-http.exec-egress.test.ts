import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { PreparedAgentRunAdmission } from "../agents/admitted-run-context.js";
import { waitForExecScope } from "../agents/bash-process-registry.js";
import type { dispatchInboundMessageWithRoutedChannelDispatcher } from "../auto-reply/dispatch.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import * as configSnapshot from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { drainSystemEvents, peekSystemEventEntries } from "../infra/system-events.js";
import * as proxyServer from "../secrets/egress-proxy/proxy-server.js";
import * as proxyRegistry from "../secrets/egress-proxy/registry.js";
import * as testState from "../test-utils/openclaw-test-state.js";
import { revokeMcpLoopbackClientGrant, type McpLoopbackRequestContext } from "./mcp-grant-store.js";
import * as mcp from "./mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";

// mock-isolation: Keep completion admission deferred while the real process and egress owners settle.
vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: vi.fn<
    typeof dispatchInboundMessageWithRoutedChannelDispatcher
  >(async ({ replyOptions }) => {
    const lifecycle = expectDefined(replyOptions?.turnAdoptionLifecycle, "completion lifecycle");
    const signal = expectDefined(lifecycle.abortSignal, "completion cancellation");
    lifecycle.onDeferred?.();
    const onAbort = async () => {
      try {
        await lifecycle.onAbandoned?.();
      } finally {
        await lifecycle.onSettled?.();
      }
    };
    signal.addEventListener("abort", () => void onAbort(), { once: true });
    if (signal.aborted) {
      await onAbort();
    }
    return {
      deferredToActiveRun: "followup",
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    };
  }),
}));

let state: testState.OpenClawTestState;
let proxy: proxyServer.SecretEgressProxyHandle;
let config: OpenClawConfig;
const admissions: PreparedAgentRunAdmission[] = [];
const grants: string[] = [];
const completionSessionKey = "agent:probe:telegram:group:-100155462274:topic:42";
const enqueue = vi.spyOn(sessionEvents, "enqueueSessionEventForHost");
const completions = () =>
  enqueue.mock.results.flatMap((entry) => (entry.type === "return" ? [entry.value] : []));

beforeAll(async () => {
  state = await testState.createOpenClawTestState({
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
  configSnapshot.setRuntimeConfigSnapshot(config);
  await replaceSessionEntry(
    { agentId: "probe", sessionKey: completionSessionKey },
    { sessionId: "mcp-origin", lifecycleRevision: "mcp-origin-revision", updatedAt: Date.now() },
  );
  proxy = await proxyServer.startSecretEgressProxyServer({
    caDir: state.path("proxy-ca"),
    allowedHosts: [],
    onAudit: () => {},
  });
  proxyRegistry.publishSecretEgressProxy(proxy);
  await ensureMcpLoopbackServer();
});

afterAll(async () => {
  grants.forEach(revokeMcpLoopbackClientGrant);
  admissions.forEach((admission) => admission.close());
  await waitForExecScope(completionSessionKey);
  drainSystemEvents(completionSessionKey);
  await Promise.all(completions().map((receipt) => receipt.settled));
  await closeMcpLoopbackServer();
  vi.restoreAllMocks();
  configSnapshot.clearRuntimeConfigSnapshot();
  if (proxy) {
    proxyRegistry.clearSecretEgressProxy(proxy);
    await proxy.stop();
  }
  await state?.cleanup();
});

async function mintExecGrant(
  runId: string,
  turn: Partial<McpLoopbackRequestContext> = { trigger: "cron" },
  args: Record<string, unknown> = { command: "echo mcp-egress-ok", yieldMs: 10000 },
) {
  const runtime = mcp.runtime();
  const admission = mcp.prepareAdmission(runId, "cron.agent", {
    cfg: config,
    agentId: "probe",
    kind: "schedule",
  });
  admissions.push(admission);
  const admittedRunContext = await admission.admit("gateway");
  const grant = mcp.captureGrant(
    {
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
    },
    "capture-" + runId,
    (token) => grants.push(token),
  );
  const request = (method: "tools/list" | "tools/call") =>
    mcp.request(
      runtime,
      method === "tools/call" ? mcp.toolCall("exec", args) : { jsonrpc: "2.0", id: 1, method },
      grant,
    );
  return { token: grant.token, admission, request };
}

async function expectExecResponse(response: Response, text: string) {
  expect(await mcp.json(response)).toMatchObject({
    result: {
      isError: false,
      content: [expect.objectContaining({ text: expect.stringContaining(text) })],
    },
  });
}

it("executes egress-enabled commands through cached CLI grants and rejects a retired grant", async () => {
  const first = await mintExecGrant("mcp-egress-first");
  expect(await mcp.json(await first.request("tools/list"))).toMatchObject({
    result: { tools: [{ name: "exec" }] },
  });
  // tools/list constructed and cached the tool before this HTTP invocation.
  await expectExecResponse(await first.request("tools/call"), "mcp-egress-ok");
  first.admission.close();
  const retired = await first.request("tools/call");
  expect(retired.status).toBe(401);
  await retired.body?.cancel();

  // A later admitted run in the same session must remain independently usable.
  const next = await mintExecGrant("mcp-egress-next");
  await expectExecResponse(await next.request("tools/call"), "mcp-egress-ok");
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
  await expectExecResponse(await request("tools/call"), "Command still running");

  await waitForExecScope(sessionKey);
  const receipt = expectDefined(completions()[0], "conversation completion receipt");
  await expect(receipt.accepted).resolves.toEqual({ ok: true });
  expect(enqueue).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("mcp-chain-ok"),
    expect.objectContaining({
      agentId: "probe",
      sessionKey,
      source: "exec",
      expectedTarget: expect.objectContaining({ sessionId: "mcp-origin", sessionKey }),
    }),
  );
  expect(peekSystemEventEntries(sessionKey)).toMatchObject([
    {
      id: receipt.id,
      text: expect.stringContaining("mcp-chain-ok"),
      deliveryContext: {
        channel: "telegram",
        to: "telegram:-100155462274:topic:42",
        threadId: "42",
      },
    },
  ]);
});
