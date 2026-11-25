import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { ConfigAuditRecord } from "../../../config/io.audit.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { repairGeneratedModelMetadataCorruption } from "./model-metadata-corruption-repair.js";

const configPath = path.resolve("/tmp/openclaw-model-metadata-corruption.json");
const preservedModel = {
  id: "gpt-5.6-sol",
  name: "gpt-5.6-sol",
  contextWindow: 272_000,
  contextTokens: 272_000,
  api: "openai-chatgpt-responses" as const,
};
type RepairParams = Parameters<typeof repairGeneratedModelMetadataCorruption>[0];
function corruptedConfig(): OpenClawConfig {
  const model = {
    ...preservedModel,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 8192,
  };
  return {
    models: {
      providers: {
        openai: {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          models: [model],
        },
      },
    },
  };
}

function writeRecord(
  overrides: Partial<Extract<ConfigAuditRecord, { event: "config.write" }>> = {},
): ConfigAuditRecord {
  return {
    ts: "2026-08-28T00:00:00.000Z",
    source: "config-io",
    event: "config.write",
    result: "rename",
    configPath,
    pid: 1,
    ppid: 0,
    cwd: "/tmp",
    argv: ["openclaw", "update", "finalize", "--yes", "--channel", "dev"],
    execArgv: [],
    watchMode: false,
    watchSession: null,
    watchCommand: null,
    existsBefore: true,
    previousHash: "before",
    nextHash: "current",
    previousBytes: 100,
    nextBytes: 200,
    previousDev: null,
    nextDev: null,
    previousIno: null,
    nextIno: null,
    previousMode: null,
    nextMode: null,
    previousNlink: null,
    nextNlink: null,
    previousUid: null,
    nextUid: null,
    previousGid: null,
    nextGid: null,
    changedPathCount: 96,
    changedPaths: [
      "models.providers.openai.models[0].reasoning",
      "models.providers.openai.models[0].input",
      "models.providers.openai.models[0].cost",
      "models.providers.openai.models[0].maxTokens",
      "…+92 more",
    ],
    hasMetaBefore: true,
    hasMetaAfter: true,
    gatewayModeBefore: "local",
    gatewayModeAfter: "local",
    suspicious: [],
    ...overrides,
  };
}

function repair(config = corruptedConfig(), overrides: Partial<RepairParams> = {}) {
  return repairGeneratedModelMetadataCorruption({
    config,
    authoredRoot: structuredClone(config),
    configPath,
    currentHash: "current",
    loadAuditRecords: () => [writeRecord()],
    ...overrides,
  });
}

it("removes only the audit-proven generic fallback quartet", () => {
  const config = corruptedConfig();
  const before = structuredClone(config);
  const loadAuditRecords = vi.fn(() => [writeRecord()]);
  const result = repair(config, { loadAuditRecords });
  expect(config).toEqual(before);
  expect(loadAuditRecords).toHaveBeenCalledOnce();
  const model = result.config.models?.providers?.openai?.models[0];
  expect(model).toStrictEqual(preservedModel);
  expect(result.changes).toHaveLength(1);
  expect(result.warnings).toEqual([]);
});

it.each(["failed write", "unrelated paths", "custom route", "included models"])(
  "leaves an exact fingerprint unchanged with %s",
  (scenario) => {
    const config = corruptedConfig();
    const overrides: Partial<RepairParams> = {};
    if (scenario === "failed write") {
      overrides.loadAuditRecords = () => [writeRecord({ result: "failed", nextHash: null })];
    } else if (scenario === "unrelated paths") {
      overrides.loadAuditRecords = () => [
        writeRecord({
          changedPaths: ["reasoning", "input", "cost", "maxTokens"].map(
            (field) => `models.providers.anthropic.models[0].${field}`,
          ),
        }),
      ];
    } else if (scenario === "custom route") {
      const provider = expectDefined(config.models?.providers?.openai, "provider fixture");
      provider.api = "openai-responses";
      provider.baseUrl = "https://proxy.example.test/v1";
    } else {
      overrides.authoredRoot = { models: { $include: "models.json" } };
    }
    const result = repair(config, overrides);
    expect(result.config).toEqual(config);
    expect(result.changes).toEqual([]);
    if (scenario === "included models") {
      expect(result.warnings).toHaveLength(1);
    } else {
      expect(result.warnings.join("\n")).toContain(
        scenario === "custom route" ? "configured API route is not owned" : "left unchanged",
      );
    }
  },
);

it.each(["partial fallback tuple", "custom model"])("does not diagnose a %s", (scenario) => {
  const config = corruptedConfig();
  const model = expectDefined(config.models?.providers?.openai?.models[0], "model fixture");
  if (scenario === "partial fallback tuple") {
    Reflect.deleteProperty(model, "cost");
  } else {
    model.id = "custom-sol";
  }
  const loadAuditRecords = vi.fn(() => [writeRecord()]);
  expect(repair(config, { loadAuditRecords })).toEqual({ config, changes: [], warnings: [] });
  expect(loadAuditRecords).not.toHaveBeenCalled();
});

it("does not load provenance for a config without model providers", () => {
  const loadAuditRecords = vi.fn(() => [writeRecord()]);
  const config = {};
  expect(repair(config, { loadAuditRecords }).config).toBe(config);
  expect(loadAuditRecords).not.toHaveBeenCalled();
});
