import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, vi } from "vitest";
import {
  resolveSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
} from "../config/sessions/session-transcript-read-fence.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../sessions/user-turn-transcript.types.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

const { execute, resolveTools } = vi.hoisted(() => ({ execute: vi.fn(), resolveTools: vi.fn() }));
// mock-isolation: avoid reading host config while probing only the listener's async context.
vi.mock("../config/io.js", () => {
  const config = {};
  return { getRuntimeConfig: () => config };
});
// mock-isolation: bypass plugin hooks so only the listener-to-tool dispatch context is measured.
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: async ({ params }: { params: unknown }) => ({ blocked: false, params }),
}));
// mock-isolation: supply a synthetic tool that records the async stores seen at dispatch.
vi.mock("./tool-resolution.js", () => ({ resolveGatewayScopedTools: resolveTools }));

const completed = { content: [{ type: "text", text: "probe completed" }] };
let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
});

export async function assertColdImportContextCleared(): Promise<void> {
  const session = { agentId: "main", sessionId: "first-turn-session" };
  const receipt: UserTurnTranscriptAdmissionReceipt = {
    ...session,
    sessionKey: "agent:main:first-turn",
    storePath: "first-turn-store",
    generation: "first-turn-generation",
    entryId: "first-turn-user",
    rawSeq: 1,
    effectiveParentId: null,
    activeMessagePosition: 0,
    logicalTurnId: "first-turn",
    role: "user",
  };
  const turnLocal = new AsyncLocalStorage<string>();
  const observed: unknown[] = [];
  execute.mockImplementation(() => {
    observed.push([resolveSessionTranscriptReadFence(session), turnLocal.getStore()]);
    return completed;
  });
  resolveTools.mockImplementation(() => ({
    agentId: "main",
    tools: [
      {
        name: "scope_probe",
        label: "Scope probe",
        description: "Synthetic tool for listener context proof",
        parameters: { type: "object", properties: {} },
        execute,
      },
    ],
  }));
  // A local CLI turn evaluates the listener module for the first time.
  const mcp = await turnLocal.run("first-turn", () =>
    runWithSessionTranscriptReadFence(receipt, () => import("./mcp-http.js")),
  );
  closeServer = mcp.closeMcpLoopbackServer;
  await turnLocal.run("second-turn", () => mcp.ensureMcpLoopbackServer());
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("MCP runtime missing");
  }
  const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.ownerToken}`,
      "content-type": "application/json",
      "x-session-key": "agent:main:scope-proof",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "scope_probe", arguments: {} },
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ result: { ...completed, isError: false } });
  expect(observed).toEqual([[undefined, undefined]]);
}
