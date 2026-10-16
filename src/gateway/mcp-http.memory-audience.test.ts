import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { MemoryAudience } from "../plugins/memory-provider-types.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintAttachGrant,
  mintMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer } from "./mcp-http.js";
import { jsonHeaders, sendRaw, startLoopbackServerForTest } from "./mcp-http.test-support.js";
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

let runtime: Awaited<ReturnType<typeof startLoopbackServerForTest>>["runtime"];
beforeAll(async () => {
  ({ runtime } = await startLoopbackServerForTest());
});
afterAll(async () => {
  await closeMcpLoopbackServer();
  vi.restoreAllMocks();
});

async function listTools(token: string, headers: Record<string, string> = {}) {
  const response = await sendRaw({
    port: runtime.port,
    token,
    headers: jsonHeaders(headers),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(response.status).toBe(200);
}

it("carries a memory audience only from a run-bound CLI grant", async () => {
  resolveTools.mockResolvedValue({
    agentId: "main",
    workspaceDir: "/tmp/openclaw-workspace",
    captureFinalCronCreatorTools: undefined,
    tools: [],
  });
  const sessionKey = "agent:main:telegram:direct:owner";
  const sessionId = "session-memory";
  const memoryAudience: MemoryAudience = Object.freeze({ kind: "owner-private", agentId: "main" });
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId: "run-memory-audience",
      agentId: "main",
      ingress: { kind: "system", boundary: "mcp-http-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef("run-memory-audience"),
  });
  try {
    const grant = mintMcpLoopbackClientGrant({
      context: { sessionKey, sessionId, senderIsOwner: true },
      runtimeOwnerToken: runtime.ownerToken,
      admittedRunContext: await admission.admit("gateway", "gateway-run-memory-audience"),
      memoryAudience,
    });
    const captureKey = "capture-memory-audience";
    activateMcpLoopbackClientGrantCapture({
      token: grant.token,
      runtimeOwnerToken: runtime.ownerToken,
      captureKey,
    });
    const attach = mintAttachGrant({ sessionKey });

    expect(grant.context).not.toHaveProperty("memoryAudience");
    await listTools(grant.token, { "x-openclaw-cli-capture-key": captureKey });
    await listTools(attach.token);
    await listTools(runtime.ownerToken, {
      "x-session-key": sessionKey,
      "x-openclaw-session-id": sessionId,
    });

    const calls = resolveTools.mock.calls.map(([input]) => input);
    expect(calls.map((input) => input.sessionKey)).toEqual([sessionKey, sessionKey, sessionKey]);
    expect(calls.map((input) => input.memoryAudience)).toEqual([
      memoryAudience,
      undefined,
      undefined,
    ]);
  } finally {
    admission.close();
  }
});
