import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import { AgentsListResultSchema } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import {
  CronListParamsSchema,
  CronRunsParamsSchema,
  CronRunLogEntrySchema,
  CronStatusParamsSchema,
} from "../../packages/gateway-protocol/src/schema/cron.js";
import { SessionsListParamsSchema } from "../../packages/gateway-protocol/src/schema/sessions-list.js";
import { CORE_BOARD_DATA_BINDING_IDS } from "../boards/board-host-capability-ids.js";
import { describeDashboardCapabilityContract } from "./dashboard-capability-contract.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

it("describes recorded automation results separately from scheduling and delivery", () => {
  expect(describeDashboardCapabilityContract("cron.runs", undefined)).toMatchObject({
    kind: "read",
    inputSchema: CronRunsParamsSchema,
    rowSchema: CronRunLogEntrySchema,
    resultCoverage: "partial",
    semantics: expect.arrayContaining([
      expect.stringContaining("Successful execution does not imply successful delivery"),
      expect.stringContaining("never runs, enables or modifies"),
    ]),
  });
});

it("reuses canonical schemas and explicitly marks partial session projections", () => {
  const agents = describeDashboardCapabilityContract("agents.list", undefined);
  expect(agents).toMatchObject({
    status: "documented",
    resultSchema: AgentsListResultSchema,
    resultCoverage: "schema",
  });
  const sessions = describeDashboardCapabilityContract("sessions.list", undefined);
  expect(sessions).toMatchObject({
    inputSchema: SessionsListParamsSchema,
    resultCoverage: "partial",
    rowFields: {
      agentId: expect.stringContaining("never infer"),
      hasActiveRun: expect.stringContaining("unknown"),
    },
    resultFields: {
      hasMore: expect.stringContaining("incomplete"),
      rowsUnchanged: expect.stringContaining("not an empty"),
    },
  });
  expect(sessions).not.toHaveProperty("resultSchema");
  expect(describeDashboardCapabilityContract("cron.trigger", undefined)).toMatchObject({
    status: "metadata_only",
    resultCoverage: "unavailable",
  });
});

it("describes only selected registrations without invoking handlers or exposing their state", () => {
  const registry = createEmptyPluginRegistry();
  const handler = vi.fn(() => {
    throw new Error("must never execute");
  });
  registry.dashboardDataBindings.set("weather.conditions", {
    id: "conditions",
    capabilityId: "weather.conditions",
    pluginId: "weather",
    method: "weather.read",
    description: "Current weather",
    handler,
  });
  registry.dashboardActionVerbs.set("lights.level", {
    id: "level",
    capabilityId: "lights.level",
    pluginId: "lights",
    method: "lights.set",
    description: "Set a selected light",
    handler,
    requiredActionBindingParams: ["deviceId"],
    paramShape: {
      type: "object",
      properties: { brightness: { type: "number", minimum: 0, maximum: 1 } },
    },
  });
  const weather = describeDashboardCapabilityContract("weather.conditions", registry);
  expect(weather).toMatchObject({ owner: "weather", kind: "read", resultCoverage: "unavailable" });
  expect(JSON.stringify(weather)).not.toMatch(/handler|lights|brightness/);
  const lights = describeDashboardCapabilityContract("lights.level", registry);
  expect(lights).toMatchObject({
    owner: "lights",
    kind: "action",
    requiredActionBindingParams: ["deviceId"],
    inputSchema: { properties: { brightness: { maximum: 1 } } },
  });
  expect(handler).not.toHaveBeenCalled();
  registry.dashboardActionVerbs.delete("lights.level");
  expect(describeDashboardCapabilityContract("lights.level", registry)).toMatchObject({
    status: "unknown_or_inactive",
  });
});

it("bounds metadata without returning a misleading truncated schema", () => {
  const registry = createEmptyPluginRegistry();
  registry.dashboardDataBindings.set("large.read", {
    id: "read",
    capabilityId: "large.read",
    pluginId: "large",
    method: "large.read",
    description: "a".repeat(33 * 1024),
    handler: vi.fn(() => {
      throw new Error("Metadata discovery must not invoke the registered handler");
    }),
  });
  expect(describeDashboardCapabilityContract("large.read", registry)).toMatchObject({
    status: "contract_too_large",
  });
  expect(describeDashboardCapabilityContract("x".repeat(257), registry)).toMatchObject({
    status: "invalid_id",
  });
  expect(describeDashboardCapabilityContract("toString", registry)).toMatchObject({
    status: "unknown_or_inactive",
  });
});

it("returns detached metadata, preserving the canonical contract between calls", () => {
  const first = describeDashboardCapabilityContract("agents.list", undefined);
  Reflect.set(first, "resultSchema", {});
  expect(describeDashboardCapabilityContract("agents.list", undefined)).toMatchObject({
    resultSchema: AgentsListResultSchema,
  });
});

it.each(CORE_BOARD_DATA_BINDING_IDS)("returns bounded, honest core read metadata for %s", (id) => {
  const result = describeDashboardCapabilityContract(id, undefined);
  expect(result).toMatchObject({ id, status: "documented", kind: "read" });
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(32 * 1024);
  if (id !== "agents.list") {
    expect(result).toMatchObject({ resultCoverage: "partial" });
    expect(result).not.toHaveProperty("resultSchema");
  }
});

it("advertises the actual cron input validators and keeps compact rows separate from full rows", () => {
  const list = describeDashboardCapabilityContract("cron.list", undefined);
  expect(list).toMatchObject({
    inputSchema: CronListParamsSchema,
    resultFields: {
      hasMore: expect.stringContaining("incomplete"),
      snapshotRevision: expect.stringContaining("revision"),
    },
    compactRowFields: {
      nextRunAtMs: expect.stringContaining("milliseconds"),
      lastRunStatus: expect.stringContaining("does not mean success"),
    },
  });
  expect(
    Value.Check(CronListParamsSchema, { compact: true, limit: 200, offset: 0, agentId: "alpha" }),
  ).toBe(true);
  expect(Value.Check(CronListParamsSchema, { compact: true, limit: 201 })).toBe(false);
  expect(describeDashboardCapabilityContract("cron.status", undefined)).toMatchObject({
    inputSchema: CronStatusParamsSchema,
    resultFields: {
      jobs: expect.stringContaining("not an array"),
      nextWakeAtMs: expect.stringContaining("not a guaranteed"),
    },
  });
});

it("exposes quota errors and freshness without conflating quota, costs and disk capacity", () => {
  expect(describeDashboardCapabilityContract("usage.status", undefined)).toMatchObject({
    inputCoverage: "empty-request",
    resultFields: { refreshing: expect.stringContaining("incomplete") },
    providerFields: {
      error: expect.stringContaining("not render"),
      windows: expect.stringContaining("does not mean zero"),
    },
    windowFields: {
      usedPercent: expect.stringContaining("not percent remaining"),
      resetAt: expect.stringContaining("milliseconds"),
    },
  });
  expect(describeDashboardCapabilityContract("usage.cost", undefined)).toMatchObject({
    inputCoverage: "unavailable",
    totalsFields: {
      missingCostEntries: expect.stringContaining("unpriced"),
      totalCost: expect.stringContaining("not remaining credit"),
    },
  });
  const health = describeDashboardCapabilityContract("health", undefined);
  expect(health).toMatchObject({
    resultFields: { ok: expect.stringContaining("not proof") },
    inputCoverage: "unavailable",
  });
  expect(health).not.toHaveProperty("resultFields.free");
  expect(health).not.toHaveProperty("resultFields.disk");
});
