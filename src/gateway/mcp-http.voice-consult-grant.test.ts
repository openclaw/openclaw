import { afterAll, beforeAll, expect, it } from "vitest";
import type { PreparedAgentRunAdmission } from "../agents/admitted-run-context.js";
import { buildCliMcpGrantContext } from "../agents/cli-runner/mcp-grant-context.js";
import type { RunCliAgentParams } from "../agents/cli-runner/types.js";
import * as configSnapshot from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as testState from "../test-utils/openclaw-test-state.js";
import { revokeMcpLoopbackClientGrant } from "./mcp-grant-store.js";
import * as mcp from "./mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";

let state: testState.OpenClawTestState;
let config: OpenClawConfig;
const admissions: PreparedAgentRunAdmission[] = [];
const grants: string[] = [];
const caller = "+15550001234";

beforeAll(async () => {
  state = await testState.createOpenClawTestState({
    prefix: "openclaw-mcp-voice-consult-",
    layout: "state-only",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  config = {
    agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
    plugins: { enabled: false },
    // A guest-facing default; the owner's own number gets the full surface.
    tools: { toolsBySender: { "*": { deny: ["sessions_send"] }, [`id:${caller}`]: {} } },
  };
  await state.writeConfig(config);
  configSnapshot.setRuntimeConfigSnapshot(config);
  await ensureMcpLoopbackServer();
});

afterAll(async () => {
  grants.forEach(revokeMcpLoopbackClientGrant);
  admissions.forEach((admission) => admission.close());
  await closeMcpLoopbackServer();
  configSnapshot.clearRuntimeConfigSnapshot();
  await state?.cleanup();
});

/** The loopback grant a Claude CLI attempt mints for an owner-policy phone consult. */
async function mintConsultGrant(runId: string, run: Partial<RunCliAgentParams>) {
  const runtime = mcp.runtime();
  const admission = mcp.prepareAdmission(runId, "voice-consult-grant-test", { cfg: config });
  admissions.push(admission);
  const admittedRunContext = await admission.admit("gateway");
  const context = buildCliMcpGrantContext({
    run: {
      sessionKey: `agent:main:voice:${caller.slice(1)}`,
      sessionId: `${runId}-session`,
      runId,
      workspaceDir: state.workspaceDir,
      messageProvider: "voice",
      senderIsOwner: true,
      ...run,
    } as RunCliAgentParams,
    config,
    requireExplicitMessageTarget: false,
    agentId: "main",
    modelProvider: "claude-cli",
    modelId: "sonnet",
  });
  const grant = mcp.captureGrant(
    {
      runtimeOwnerToken: runtime.ownerToken,
      admittedRunContext,
      // The runner projects an exact list, so native coding tools are mediated and node exec
      // is not offered; sender policy must not depend on node exec.
      context: { ...context, toolsAllow: ["read", "sessions_send", "sessions_list", "tts"] },
    },
    "capture-" + runId,
    (token) => grants.push(token),
  );
  const list = async () => {
    const response = (await mcp.json(
      await mcp.request(runtime, { jsonrpc: "2.0", id: 1, method: "tools/list" }, grant),
    )) as { result: { tools: { name: string }[] } };
    return response.result.tools.map((tool) => tool.name).toSorted();
  };
  const call = async (name: string, args: Record<string, unknown>) =>
    await mcp.json(await mcp.request(runtime, mcp.toolCall(name, args), grant));
  return { list, call };
}

it("keeps the guest wildcard policy and voice surface on a senderless consult grant", async () => {
  const consult = await mintConsultGrant("voice-consult-guest", {});

  expect(await consult.list()).toEqual(["read", "sessions_list"]);
  expect(
    await consult.call("sessions_send", { sessionKey: "agent:main:main", message: "Hi" }),
  ).toMatchObject({
    result: { isError: true, content: [{ text: expect.stringContaining("sessions_send") }] },
  });
});

it("gives an identified caller their own sender policy on a delivery channel", async () => {
  const consult = await mintConsultGrant("voice-consult-owner", {
    senderId: caller,
    messageChannel: "telegram",
  });

  expect(await consult.list()).toEqual(["read", "sessions_list", "sessions_send", "tts"]);
});
