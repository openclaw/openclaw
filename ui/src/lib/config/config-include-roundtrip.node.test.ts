// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveConfigIncludes } from "../../../../src/config/includes.js";
import {
  redactConfigSnapshot,
  restoreRedactedValues,
} from "../../../../src/config/redact-snapshot.js";
import { buildConfigSchemaCore } from "../../../../src/config/schema.js";
import { projectRuntimeChangesOntoSource } from "../../../../src/config/source-value-projection.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { validateConfigObjectRaw } from "../../../../src/config/validation-core.js";
import {
  applyConfigSnapshot,
  serializeFormForSubmit,
  updateConfigFormValue,
} from "./config-draft-model.ts";
import { createInitialConfigState } from "./config-state-model.ts";

const { uiHints: hints } = buildConfigSchemaCore();

const provider = {
  baseUrl: "https://provider.example.test/v1",
  api: "openai-completions" as const,
  apiKey: { source: "env" as const, provider: "default", id: "EXAMPLE_API_KEY" },
  headers: { Authorization: "synthetic-provider-header" },
  models: [{ id: "fixture", name: "Fixture" }],
};

function snapshot(included: boolean): ConfigFileSnapshot {
  const authored = {
    models: { providers: { fixture: provider } },
    channels: { discord: { enabled: false, token: "synthetic-channel-token" } },
    logging: { level: "info" as const },
  };
  const parsed = included
    ? {
        models: { $include: "./models.json5" },
        channels: { $include: "./channels.json5" },
        logging: authored.logging,
      }
    : authored;
  const resolved = resolveConfigIncludes(parsed, "/fixture/openclaw.json", {
    readFile: (file) =>
      JSON.stringify(file.endsWith("models.json5") ? authored.models : authored.channels),
    parseJson: JSON.parse,
  }) as OpenClawConfig;
  return {
    path: "/fixture/openclaw.json",
    exists: true,
    raw: JSON.stringify(parsed),
    parsed,
    sourceConfig: resolved,
    resolved,
    config: resolved,
    runtimeConfig: resolved,
    valid: true,
    hash: "fixture-revision",
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

describe("config form authored-source round-trip", () => {
  it.each([false, true])("restores credentials after a form save (included: %s)", (included) => {
    const original = snapshot(included);
    const state = createInitialConfigState();
    applyConfigSnapshot(state, redactConfigSnapshot(original, hints));
    updateConfigFormValue(state, ["logging", "level"], "debug");
    const submitted = JSON.parse(serializeFormForSubmit(state));
    const restored = restoreRedactedValues(submitted, original.config, hints);
    expect(restored.ok).toBe(true);
    const candidate = projectRuntimeChangesOntoSource(
      original.resolved,
      original.config,
      restored.result,
    );
    const validation = validateConfigObjectRaw(candidate);
    expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
    expect(candidate).toEqual({ ...original.sourceConfig, logging: { level: "debug" } });
  });

  it("does not submit credentials present only in the runtime snapshot", () => {
    const original = snapshot(true);
    original.config = {
      ...original.config,
      gateway: { auth: { token: "synthetic-runtime-token" } },
    };
    original.runtimeConfig = original.config;
    const state = createInitialConfigState();
    applyConfigSnapshot(state, redactConfigSnapshot(original, hints));
    updateConfigFormValue(state, ["logging", "level"], "debug");
    expect(JSON.parse(serializeFormForSubmit(state))).not.toHaveProperty("gateway");
  });
});
