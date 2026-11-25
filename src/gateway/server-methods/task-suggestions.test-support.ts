import { expect, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { taskSuggestionsHandlers } from "./task-suggestions.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export const GIT_CWD = process.cwd();
export const SOURCE_SESSION_KEY = "agent:main:source";

export async function call(
  method: `taskSuggestions.${"list" | "create" | "accept" | "dismiss"}`,
  params: Record<string, unknown>,
  broadcast = vi.fn(),
  overrides: Record<string, unknown> & {
    client?: GatewayClient | null;
    context?: Partial<GatewayRequestContext>;
    config?: Record<string, unknown>;
  } = {},
) {
  const calls: Parameters<RespondFn>[] = [];
  const config =
    overrides.config ??
    (overrides.client !== undefined || overrides.context !== undefined ? {} : overrides);
  const context = { broadcast, getRuntimeConfig: () => config, ...overrides.context };
  setRuntimeConfigSnapshot(context.getRuntimeConfig());
  await taskSuggestionsHandlers[method]?.({
    req: { type: "req", id: "request-1", method, params },
    params,
    respond: (...args: Parameters<RespondFn>) => calls.push(args),
    client: overrides.client ?? null,
    isWebchatConnect: () => true,
    context,
  } as never);
  return { response: calls[0], broadcast };
}

export function requirePayload(result: Awaited<ReturnType<typeof call>>): unknown {
  expect(result.response?.[0]).toBe(true);
  return result.response?.[1];
}

export async function dismissPendingTaskSuggestions(): Promise<void> {
  const listed = await call("taskSuggestions.list", {});
  const payload = requirePayload(listed) as { suggestions: Array<{ id: string }> };
  for (const suggestion of payload.suggestions) {
    await call("taskSuggestions.dismiss", { taskId: suggestion.id });
  }
}

export const operatorClient = (): GatewayClient => ({
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
    role: "operator",
    scopes: ["operator.admin"],
    caps: [GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS],
  },
});

export const configuredCloudContext = (
  profiles: Record<string, { provider: string }> = { primary: { provider: "test" } },
): Partial<GatewayRequestContext> => ({
  workerEnvironmentService: {} as never,
  workerPlacementDispatchService: {} as never,
  getRuntimeConfig: () => ({ cloudWorkers: { profiles } }),
});

async function createSuggestion(source: boolean) {
  const created = await call("taskSuggestions.create", {
    cwd: GIT_CWD,
    agentId: "main",
    title: source ? "Fix the source session" : "Add coverage",
    prompt: source ? "Apply the focused fix in this session." : "Add the missing regression test.",
    tldr: source ? "Source context." : "Untested edge case.",
    sessionKey: source ? SOURCE_SESSION_KEY : "agent:main:main",
  });
  return (requirePayload(created) as { taskId: string }).taskId;
}

export const createSourceSuggestion = () => createSuggestion(true);
export const createLocalTaskSuggestion = () => createSuggestion(false);
