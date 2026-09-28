import { expect, it } from "vitest";
import { createCronTool } from "./cron-tool.js";
import type { GatewayToolCaller } from "./cron-tool.types.js";
import type { GatewayCallOptions } from "./gateway.js";

it("requests visibility metadata on every scoped cron list page", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const callGatewayTool: GatewayToolCaller = async <T>(
    method: string,
    _options: GatewayCallOptions,
    params?: unknown,
  ): Promise<T> => {
    const request = (params ?? {}) as Record<string, unknown>;
    calls.push({ method, params: request });
    const offset = request.offset as number;
    return {
      jobs:
        offset === 0
          ? Array.from({ length: 200 }, (_, index) => ({ id: `other-${index}` }))
          : [{ id: "current" }],
      snapshotRevision: "stable",
      total: 201,
      offset,
      limit: 200,
      hasMore: offset === 0,
      nextOffset: offset === 0 ? 200 : null,
    } as T;
  };
  const tool = createCronTool({ selfRemoveOnlyJobId: "current" }, { callGatewayTool });

  await tool.execute("cron", { action: "list" });

  expect(calls.map(({ method, params }) => [method, params.includeVisibility])).toEqual([
    ["cron.list", true],
    ["cron.list", true],
  ]);
  expect(calls.map(({ params }) => params.offset)).toEqual([0, 200]);
});

it("describes scoped cron lists without excluding authenticated owner inventories", () => {
  const tool = createCronTool();

  expect(tool.description).toContain(
    "Authenticated configured channel owner and Control UI administrator turns can list/get/update/run/remove any Gateway automation",
  );
  expect(tool.description).toContain(
    "Other turns see only caller-visible jobs; total, snapshotRevision, offset, limit, nextOffset, and hasMore describe that scoped view, not the complete Gateway inventory",
  );
  expect(tool.description).not.toContain(
    "In an agent session, list results are restricted to automations visible to the calling agent",
  );
});
