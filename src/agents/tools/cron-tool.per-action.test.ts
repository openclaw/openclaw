import { describe, expect, it } from "vitest";
import {
  CronAddSchema,
  CronGetSchema,
  CronListSchema,
  CronRemoveSchema,
  CronRunSchema,
  CronRunsSchema,
  CronStatusSchema,
  CronToolSchema,
  CronUpdateSchema,
  CronWakeSchema,
  createCronTools,
} from "./cron-tool.js";

function topLevelKeys(schema: unknown): string[] {
  const record = schema as Record<string, unknown>;
  const props = record.properties as Record<string, unknown> | undefined;
  return props ? Object.keys(props).toSorted() : [];
}

function requiredKeys(schema: unknown): string[] {
  const record = schema as Record<string, unknown>;
  const required = record.required as string[] | undefined;
  return required ? [...required].toSorted() : [];
}

/**
 * WOR-317: the legacy `cron` super-tool exposed a flat union of 14 top-level
 * keys including `action`, `job`, `patch`, `text`, `mode`, `runMode`,
 * `includeDisabled`, `agentId`, `contextMessages`. Frontier models decode that
 * shape into OpenAI-functions and emit every key with default values when
 * calling cron.update, the gateway rejects, model retries with the same
 * shape, loop. These tests assert that each per-action schema declares only
 * the keys its action actually consumes. No `action` enum, no flat union,
 * no unused keys.
 */
describe("cron per-action schemas (WOR-317)", () => {
  it("CronStatusSchema only exposes gateway-call common keys", () => {
    expect(topLevelKeys(CronStatusSchema)).toEqual(
      ["gatewayToken", "gatewayUrl", "timeoutMs"].toSorted(),
    );
    expect(topLevelKeys(CronStatusSchema)).not.toContain("action");
    expect(topLevelKeys(CronStatusSchema)).not.toContain("job");
    expect(topLevelKeys(CronStatusSchema)).not.toContain("patch");
  });

  it("CronListSchema exposes list filters but no mutation keys", () => {
    expect(topLevelKeys(CronListSchema)).toEqual(
      ["agentId", "gatewayToken", "gatewayUrl", "includeDisabled", "timeoutMs"].toSorted(),
    );
    expect(topLevelKeys(CronListSchema)).not.toContain("action");
    expect(topLevelKeys(CronListSchema)).not.toContain("job");
    expect(topLevelKeys(CronListSchema)).not.toContain("patch");
    expect(topLevelKeys(CronListSchema)).not.toContain("text");
  });

  it("CronGetSchema exposes only id parameters", () => {
    expect(topLevelKeys(CronGetSchema)).toEqual(
      ["gatewayToken", "gatewayUrl", "id", "jobId", "timeoutMs"].toSorted(),
    );
    expect(topLevelKeys(CronGetSchema)).not.toContain("patch");
    expect(topLevelKeys(CronGetSchema)).not.toContain("job");
  });

  it("CronAddSchema exposes job and contextMessages, no patch/jobId", () => {
    expect(topLevelKeys(CronAddSchema)).toEqual(
      ["contextMessages", "gatewayToken", "gatewayUrl", "job", "timeoutMs"].toSorted(),
    );
    expect(topLevelKeys(CronAddSchema)).not.toContain("action");
    expect(topLevelKeys(CronAddSchema)).not.toContain("patch");
    expect(topLevelKeys(CronAddSchema)).not.toContain("jobId");
    expect(topLevelKeys(CronAddSchema)).not.toContain("id");
  });

  /**
   * The headline assertion for WOR-317. cron.update was the action that
   * triggered the 33-call retry loop on 2026-05-21. CronUpdateSchema must
   * advertise nothing beyond {jobId?, id?, patch, gateway-common}.
   */
  it("CronUpdateSchema exposes only jobId/id + patch (no flat union)", () => {
    const keys = topLevelKeys(CronUpdateSchema);
    expect(keys).toEqual(
      ["gatewayToken", "gatewayUrl", "id", "jobId", "patch", "timeoutMs"].toSorted(),
    );
    // The cause-of-incident assertions: none of these should be on the
    // update schema regardless of how it gets extended in the future.
    expect(keys).not.toContain("action");
    expect(keys).not.toContain("job");
    expect(keys).not.toContain("text");
    expect(keys).not.toContain("mode");
    expect(keys).not.toContain("runMode");
    expect(keys).not.toContain("includeDisabled");
    expect(keys).not.toContain("agentId");
    expect(keys).not.toContain("contextMessages");
  });

  it("CronRemoveSchema exposes only id parameters", () => {
    expect(topLevelKeys(CronRemoveSchema)).toEqual(
      ["gatewayToken", "gatewayUrl", "id", "jobId", "timeoutMs"].toSorted(),
    );
    expect(topLevelKeys(CronRemoveSchema)).not.toContain("patch");
  });

  it("CronRunSchema exposes id + runMode, no schedule/patch/text", () => {
    expect(topLevelKeys(CronRunSchema)).toEqual(
      ["gatewayToken", "gatewayUrl", "id", "jobId", "runMode", "timeoutMs"].toSorted(),
    );
    expect(topLevelKeys(CronRunSchema)).not.toContain("patch");
    expect(topLevelKeys(CronRunSchema)).not.toContain("job");
    expect(topLevelKeys(CronRunSchema)).not.toContain("text");
  });

  it("CronRunsSchema exposes only id parameters", () => {
    expect(topLevelKeys(CronRunsSchema)).toEqual(
      ["gatewayToken", "gatewayUrl", "id", "jobId", "timeoutMs"].toSorted(),
    );
  });

  it("CronWakeSchema exposes only text + mode, no id/job/patch", () => {
    expect(topLevelKeys(CronWakeSchema)).toEqual(
      ["gatewayToken", "gatewayUrl", "mode", "text", "timeoutMs"].toSorted(),
    );
    expect(requiredKeys(CronWakeSchema)).toContain("text");
    expect(topLevelKeys(CronWakeSchema)).not.toContain("jobId");
    expect(topLevelKeys(CronWakeSchema)).not.toContain("id");
    expect(topLevelKeys(CronWakeSchema)).not.toContain("job");
    expect(topLevelKeys(CronWakeSchema)).not.toContain("patch");
  });

  it("CronAddSchema marks job as required (WOR-317 follow-up #1)", () => {
    // The legacy super-tool schema wraps the job object in Type.Optional so
    // every action could share one flat union; the per-action schema must
    // require it so models do not call cron_add with an empty payload.
    expect(requiredKeys(CronAddSchema)).toContain("job");
    expect(requiredKeys(CronToolSchema)).not.toContain("job");
  });

  it("CronUpdateSchema marks patch as required (WOR-317 follow-up #1)", () => {
    // Same as add: without this, the model is told it may call cron_update
    // with no patch at all and the executor will reject every such call,
    // recreating a smaller WOR-316-style retry loop.
    expect(requiredKeys(CronUpdateSchema)).toContain("patch");
    expect(requiredKeys(CronToolSchema)).not.toContain("patch");
  });

  it("no per-action schema includes the `action` enum from CronToolSchema", () => {
    const schemas = [
      CronStatusSchema,
      CronListSchema,
      CronGetSchema,
      CronAddSchema,
      CronUpdateSchema,
      CronRemoveSchema,
      CronRunSchema,
      CronRunsSchema,
      CronWakeSchema,
    ];
    for (const s of schemas) {
      expect(topLevelKeys(s)).not.toContain("action");
    }
    // The legacy super-tool schema, by contrast, still has action for the alias.
    expect(topLevelKeys(CronToolSchema)).toContain("action");
  });
});

describe("createCronTools wiring (WOR-317)", () => {
  it("returns nine per-action tools plus the legacy 'cron' alias", () => {
    const tools = createCronTools();
    const names = tools.map((t) => t.name).toSorted();
    expect(names).toEqual(
      [
        "cron",
        "cron_add",
        "cron_get",
        "cron_list",
        "cron_remove",
        "cron_run",
        "cron_runs",
        "cron_status",
        "cron_update",
        "cron_wake",
      ].toSorted(),
    );
  });

  it("each per-action tool's parameters match its narrow schema", () => {
    const tools = createCronTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("cron_status")?.parameters).toBe(CronStatusSchema);
    expect(byName.get("cron_list")?.parameters).toBe(CronListSchema);
    expect(byName.get("cron_get")?.parameters).toBe(CronGetSchema);
    expect(byName.get("cron_add")?.parameters).toBe(CronAddSchema);
    expect(byName.get("cron_update")?.parameters).toBe(CronUpdateSchema);
    expect(byName.get("cron_remove")?.parameters).toBe(CronRemoveSchema);
    expect(byName.get("cron_run")?.parameters).toBe(CronRunSchema);
    expect(byName.get("cron_runs")?.parameters).toBe(CronRunsSchema);
    expect(byName.get("cron_wake")?.parameters).toBe(CronWakeSchema);
    // Legacy alias keeps the flat union.
    expect(byName.get("cron")?.parameters).toBe(CronToolSchema);
  });
});
