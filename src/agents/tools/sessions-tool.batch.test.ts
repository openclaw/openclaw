import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { flushPendingSessionsChangedEvents } from "../../gateway/server-methods/session-change-event.js";
import { sessionMutationHandlers } from "../../gateway/server-methods/sessions-mutations.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  RespondFn,
} from "../../gateway/server-methods/types.js";
import { gatewayConnect } from "../../gateway/server/client-fixtures.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsTool } from "./sessions-tool.js";

const currentKey = "agent:main:main";
const targetKeys = ["agent:main:dashboard:first", "agent:main:dashboard:second"];
const session = (sessionKey: string) => loadSessionEntry({ agentId: "main", sessionKey });
const values = (
  field: "category" | "archivedAt" | "pinnedAt",
  keys = [...targetKeys, currentKey],
) => keys.map((key) => session(key)?.[field]);
function createTool(
  callGateway: AgentToolGatewayRequestCaller,
  config: OpenClawConfig = {},
  agentSessionId?: string,
) {
  const tool = createSessionsTool({
    agentSessionKey: currentKey,
    ...(agentSessionId ? { agentSessionId } : {}),
    config,
    callGateway,
  });
  return {
    parameters: tool.parameters,
    patch: (args: Record<string, unknown>) => tool.execute("batch", { action: "patch", ...args }),
  };
}

afterEach(() => flushPendingSessionsChangedEvents());

function createStoredSessionTool(config: OpenClawConfig = {}) {
  const client: GatewayClient = {
    connect: gatewayConnect(["operator.read", "operator.write"], {
      id: "gateway-client",
      mode: "backend",
    }),
  };
  const context = {
    getRuntimeConfig: () => config,
    loadGatewayModelCatalog: async () => [],
    getSessionEventSubscriberConnIds: () => new Set(),
    broadcastToConnIds: vi.fn(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
  const callGateway: AgentToolGatewayRequestCaller = async <T>(
    request: Parameters<AgentToolGatewayRequestCaller>[0],
  ) => {
    const handler = sessionMutationHandlers[request.method];
    if (!handler) {
      throw new Error(`Unexpected Gateway request: ${request.method}`);
    }
    const respond = vi.fn<RespondFn>();
    await handler({
      req: { type: "req", id: "batch-tool-test", method: request.method, params: request.params },
      params: request.params as Record<string, unknown>,
      respond,
      context,
      client,
      isWebchatConnect: () => false,
    });
    const [ok, payload, error] = respond.mock.calls[0]!;
    if (!ok) {
      throw new GatewayClientRequestError(error!);
    }
    return payload as T;
  };
  return createTool(callGateway, config, "current-session");
}

async function withStoredTool(
  run: (tool: ReturnType<typeof createTool>) => Promise<void>,
  config: OpenClawConfig = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(config);
    for (const [index, sessionKey] of [currentKey, ...targetKeys].entries()) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: index === 0 ? "current-session" : `target-${index}`, updatedAt: 1 },
      );
    }
    await run(createStoredSessionTool(config));
  });
}

describe("sessions tool batch patch", () => {
  it("groups the selected sessions through the Gateway and reports a replaced target without touching the current session", () =>
    withStoredTool(async (tool) => {
      const targets = targetKeys.map((sessionKey, index) => ({
        sessionKey,
        expectedSessionId: `target-${index + 1}`,
      }));
      expect(Value.Check(tool.parameters, { action: "patch", targets, group: "Reviews" })).toBe(
        true,
      );
      const grouped = await tool.patch({ targets, group: "Reviews" });
      expect(grouped.details).toMatchObject({ status: "updated", succeeded: [0, 1], failed: [] });
      expect(values("category", targetKeys)).toEqual(["Reviews", "Reviews"]);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: targetKeys[1]! },
        { sessionId: "replacement", updatedAt: 2, category: "Replacement" },
      );
      const changed = await tool.patch({ targets, group: "Done" });
      expect(changed.details).toMatchObject({
        status: "partial",
        succeeded: [0],
        failed: [1],
        errors: [{ index: 1, message: expect.stringContaining("changed") }],
      });
      expect(values("category")).toEqual(["Done", "Replacement", undefined]);
    }));

  it("continues valid archives after missing identity and current-session targets", () =>
    withStoredTool(async (tool) => {
      const result = await tool.patch({
        targets: [
          { sessionKey: targetKeys[0] },
          { sessionKey: currentKey, expectedSessionId: "current-session" },
          { sessionKey: targetKeys[1], expectedSessionId: "target-2" },
        ],
        archived: true,
      });
      expect(result.details).toMatchObject({ status: "partial", succeeded: [2], failed: [0, 1] });
      expect(values("archivedAt")).toEqual([undefined, expect.any(Number), undefined]);
    }));

  it("preserves session visibility while applying allowed targets", () =>
    withStoredTool(
      async (tool) => {
        const result = await tool.patch({
          targets: [{ sessionKey: targetKeys[0] }, { sessionKey: "current" }],
          pinned: true,
        });
        expect(result.details).toMatchObject({ status: "partial", succeeded: [1], failed: [0] });
        expect(values("pinnedAt", [currentKey, targetKeys[0]!])).toEqual([
          expect.any(Number),
          undefined,
        ]);
      },
      { tools: { sessions: { visibility: "self" } } },
    ));

  it.each([
    { targets: Array.from({ length: 101 }, () => ({ sessionKey: currentKey })) },
    { targets: [{ sessionKey: currentKey }], expectedSessionId: "current-session" },
  ])("rejects invalid batch %j before dispatch", async (args) => {
    const callGateway = vi.fn();
    const tool = createTool(callGateway);
    await expect(tool.patch({ pinned: true, ...args })).rejects.toThrow();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("accounts for all 100 failures within the response budget", async () => {
    const targets = Array.from({ length: 100 }, (_, index) => ({
      sessionKey: `agent:main:dashboard:${index}`,
    }));
    const callGateway = vi.fn(async () => ({
      outcomes: targets.map(({ sessionKey }) => ({
        ok: false,
        key: sessionKey,
        error: { code: "INVALID_REQUEST", message: "界".repeat(10_000) },
      })),
    }));
    const tool = createTool(callGateway as AgentToolGatewayRequestCaller);
    const result = await tool.patch({ pinned: true, targets });
    expect(result.details).toMatchObject({
      status: "error",
      succeeded: [],
      failed: Array.from({ length: 100 }, (_, index) => index),
      warning: expect.stringContaining("omitted"),
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(3_840);
  });
});
