import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

export const runtime = () => expectDefined(getActiveMcpLoopbackRuntime(), "MCP runtime");

export async function json(response: Response): Promise<unknown> {
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return JSON.parse(body);
}

export function probeTools(name: string, execute: AnyAgentTool["execute"]) {
  const tool = {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute,
  };
  return { agentId: "main", tools: [tool] };
}

type AdmissionOptions = Partial<
  Pick<Parameters<typeof prepareAgentRunAdmission>[0], "cfg" | "operatorAuthority">
> & { agentId?: string; kind?: "system" | "schedule" };

export function prepareAdmission(
  runId: string,
  boundary: string,
  { cfg = {}, agentId = "main", kind = "system", ...options }: AdmissionOptions = {},
) {
  return prepareAgentRunAdmission({
    cfg,
    ...options,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: { runId, agentId, ingress: { kind, boundary, state: "present" } },
  });
}

export function captureGrant(
  params: Parameters<typeof mintMcpLoopbackClientGrant>[0],
  captureKey: string,
  registerCleanup?: (token: string) => void,
) {
  const grant = mintMcpLoopbackClientGrant(params);
  // Failed capture setup must still revoke the freshly minted grant.
  registerCleanup?.(grant.token);
  expect(
    activateMcpLoopbackClientGrantCapture({
      token: grant.token,
      runtimeOwnerToken: params.runtimeOwnerToken,
      captureKey,
    }),
  ).not.toBe(false);
  return { ...grant, captureKey };
}

type Runtime = { port: number; ownerToken: string };

export function request(
  listener: Runtime,
  message: unknown,
  options: {
    token?: string;
    captureKey?: string;
    sessionKey?: string;
    signal?: AbortSignal;
    connection?: string;
    method?: "GET" | "POST";
  } = {},
) {
  return fetch(`http://127.0.0.1:${listener.port}/mcp`, {
    method: options.method ?? "POST",
    signal: options.signal,
    headers: {
      authorization: `Bearer ${options.token ?? listener.ownerToken}`,
      "content-type": "application/json",
      ...(options.captureKey ? { "x-openclaw-cli-capture-key": options.captureKey } : {}),
      ...(options.sessionKey ? { "x-session-key": options.sessionKey } : {}),
      ...(options.connection ? { connection: options.connection } : {}),
    },
    ...(message ? { body: JSON.stringify(message) } : {}),
  });
}

export function toolCall(
  name: string,
  args: Record<string, unknown> = {},
  id: string | number = 1,
) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}
