import { Type } from "typebox";
import { expect, it, onTestFinished, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import type { RequesterOrigin } from "../agents/requester-origin.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { resolveGatewayScopedTools } from "./tool-resolution.js";

const resolveTools = vi.hoisted(() => vi.fn<typeof resolveGatewayScopedTools>());
vi.mock("../config/io.js", async (importOriginal) => {
  const config = {};
  return {
    ...(await importOriginal<typeof import("../config/io.js")>()),
    getRuntimeConfig: () => config,
  };
});
vi.mock("../agents/agent-tools.before-tool-call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-tools.before-tool-call.js")>()),
  runBeforeToolCallHook: async ({ params }: { params: unknown }) => ({ blocked: false, params }),
}));
// mock-isolation: the real resolver loads the whole Gateway tool surface; rows check origins only.
vi.mock("./tool-resolution.js", () => ({ resolveGatewayScopedTools: resolveTools }));

import { mintMcpLoopbackClientGrant } from "./mcp-grant-store.js";
import * as mcp from "./mcp-http.test-support.js";

const runtime = mcp.useLoopbackServerForTest();
const run = "agent:main:cron:nightly:run:r1";

it.each([
  { kind: "the stamped origin the run's tools resolved", stamped: true },
  { kind: "the request's own origin without a stamp", stamped: false },
])("hands tool calls $kind", async ({ stamped }) => {
  const own: RequesterOrigin = { sessionKey: run };
  const resolved = stamped ? { ...own, scheduledRunSessionKey: run } : undefined;
  let seen: RequesterOrigin | undefined;
  const execute = vi.fn(async () => {
    seen = getGatewayToolCallerIdentity()?.requesterOrigin;
    return { content: [{ type: "text" as const, text: "origin inspected" }], details: {} };
  });
  resolveTools.mockReset().mockResolvedValue({
    ...mcp.scopedToolFixture(
      [
        {
          name: "origin_probe",
          label: "Origin probe",
          description: "Inspect the requester origin at the MCP tool boundary",
          parameters: Type.Object({}),
          execute,
        },
      ],
      "/workspace/scheduled-run-origin",
    ),
    requesterOrigin: resolved,
  } as unknown as Awaited<ReturnType<typeof resolveGatewayScopedTools>>);
  const admission = prepareSystemAgentRunAdmission({}, `run-${stamped}`, "main", "mcp-http-test");
  onTestFinished(() => admission.close());
  const grant = mintMcpLoopbackClientGrant({
    context: {
      runId: `run-${stamped}`,
      sessionKey: run,
      sessionId: "run-session",
      workspaceDir: "/workspace/scheduled-run-origin",
      agentId: "main",
      senderIsOwner: false,
      nodeExecAllowed: false,
      requesterOrigin: own,
    },
    toolPolicyConfig: {},
    runtimeOwnerToken: runtime().ownerToken,
    admittedRunContext: await admission.admit("gateway", `gateway-run-${stamped}`),
  });
  const captureKey = `capture-scheduled-run-${stamped}`;
  mcp.captureGrant(grant.token, captureKey, runtime().ownerToken);

  const payload = await mcp.readOkMcpPayload(
    await mcp.sendLoopbackToolCall({
      token: grant.token,
      name: "origin_probe",
      headers: { "x-openclaw-cli-capture-key": captureKey },
    }),
  );

  expect(payload.result?.isError).toBe(false);
  expect(execute).toHaveBeenCalledOnce();
  expect(seen).toEqual(resolved ?? own);
});
