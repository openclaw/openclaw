import { expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import type { MemoryAudience } from "../plugins/memory-provider-types.js";
import * as grants from "./mcp-grant-store.js";
import * as mcp from "./mcp-http.test-support.js";
import type { resolveGatewayScopedTools } from "./tool-resolution.js";

const resolveTools = vi.hoisted(() => vi.fn<typeof resolveGatewayScopedTools>());
// mock-isolation: observes the authority each loopback caller hands to tool resolution.
vi.mock("./tool-resolution.js", () => ({ resolveGatewayScopedTools: resolveTools }));
vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => ({ session: { mainKey: "main" } }),
}));
// mock-isolation: keeps node inventory out of the loopback catalog under test.
vi.mock("../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "eligible", isAvailable: () => true }),
}));

const runtime = mcp.useLoopbackServerForTest();

async function listTools(token: string, headers: Record<string, string> = {}) {
  const response = await mcp.sendRaw({
    port: runtime().port,
    token,
    headers: mcp.jsonHeaders(headers),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(response.status).toBe(200);
}

it("carries a memory audience only from a run-bound CLI grant", async () => {
  resolveTools.mockResolvedValue(mcp.scopedToolFixture([], "/tmp/openclaw-workspace"));
  const sessionKey = "agent:main:telegram:direct:owner";
  const sessionId = "session-memory";
  const memoryAudience: MemoryAudience = Object.freeze({ kind: "owner-private", agentId: "main" });
  const config = { session: { mainKey: "main" } };
  const admission = prepareSystemAgentRunAdmission(
    config,
    "run-memory-audience",
    "main",
    "mcp-http-test",
  );
  try {
    const grant = grants.mintMcpLoopbackClientGrant({
      context: { sessionKey, sessionId, senderIsOwner: true },
      toolPolicyConfig: config,
      runtimeOwnerToken: runtime().ownerToken,
      admittedRunContext: await admission.admit("gateway", "gateway-run-memory-audience"),
      memoryAudience,
    });
    const captureKey = "capture-memory-audience";
    mcp.captureGrant(grant.token, captureKey, runtime().ownerToken);
    const attach = grants.mintAttachGrant({ sessionKey });

    expect(grant.context).not.toHaveProperty("memoryAudience");
    await listTools(grant.token, { "x-openclaw-cli-capture-key": captureKey });
    await listTools(attach.token);
    await listTools(runtime().ownerToken, {
      "x-session-key": sessionKey,
      "x-openclaw-session-id": sessionId,
    });

    expect(
      resolveTools.mock.calls.map(([input]) => [input.sessionKey, input.memoryAudience]),
    ).toEqual([
      [sessionKey, memoryAudience],
      [sessionKey, undefined],
      [sessionKey, undefined],
    ]);
  } finally {
    admission.close();
  }
});
