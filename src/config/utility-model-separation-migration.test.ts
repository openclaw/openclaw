import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { OpenClawConfigWithLegacyRoster } from "./legacy.roster.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import {
  hasUtilityModelSeparationMigrationMarker,
  materializeUtilityModelSeparation,
  resolveUtilityModelSeparationError,
} from "./utility-model-separation-migration.js";
import { localProvider } from "./utility-model-separation.test-support.js";

function legacyConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        utilityModel: "helper@local:utility",
        model: { fallbacks: ["backup/model@backup:account"] },
        models: { "local-fixture/small": { alias: "helper" } },
      },
      entries: { worker: {}, disabled: { utilityModel: "" } },
    },
    models: { providers: { "local-fixture": localProvider() } },
    auth: { profiles: { "local:utility": { provider: "local-fixture", mode: "api_key" } } },
  };
}

describe("utility model separation migration", () => {
  it.each([
    "catalog",
    "added-provider",
    "candidate-marker",
    "builtin",
    "builtin-object",
    "small@q8_0",
    "small@20260101",
  ])("pins the implicit primary for %s", (kind) => {
    const builtin = kind.startsWith("builtin");
    const utilityModel =
      kind === "builtin-object"
        ? { primary: "remote/utility", fallbacks: ["remote/backup"] }
        : "remote/utility";
    const previous: OpenClawConfig = builtin
      ? { agents: { defaults: { utilityModel }, entries: { worker: {} } } }
      : legacyConfig();
    if (kind.startsWith("small@")) {
      expectDefined(previous.models?.providers?.["local-fixture"]?.models[0], "model").id = kind;
    }
    expect(resolveUtilityModelSeparationError(previous)).toContain("openclaw doctor --fix");
    const original = structuredClone(previous);
    const next = { ...previous };
    if (kind === "added-provider") {
      next.models = {
        providers: {
          added: localProvider("new"),
          ...previous.models?.providers,
        },
      };
    } else if (kind === "candidate-marker") {
      next.meta = { migrations: { utilityModelSeparation: true } };
    } else if (builtin) {
      next.models = legacyConfig().models;
    }
    const { config, changes } = materializeUtilityModelSeparation(next, previous);
    expect(resolveUtilityModelSeparationError(config)).toBeUndefined();
    const primary = builtin
      ? `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`
      : `local-fixture/${kind.startsWith("small@") ? kind : "small"}`;
    expect(config.agents?.defaults?.model).toEqual(
      builtin ? { primary } : { primary, fallbacks: ["backup/model@backup:account"] },
    );
    expect(config.agents?.defaults?.utilityModel).toBe(previous.agents?.defaults?.utilityModel);
    expect(config.agents?.defaults?.models).toEqual(previous.agents?.defaults?.models);
    expect(config.agents?.entries).toEqual(previous.agents?.entries);
    expect(config.auth).toEqual(previous.auth);
    expect(config.models).toBe(next.models);
    expect(hasUtilityModelSeparationMigrationMarker(config)).toBe(true);
    expect(changes).toHaveLength(1);
    expect(materializeUtilityModelSeparation(config)).toEqual({ config, changes: [] });
    expect(previous).toEqual(original);
  });

  it.each(["prefix-${LOCAL_MODEL}", "small@experimental", "non-selected-dynamic-row"])(
    "defers a catalog that cannot be pinned: %s",
    (id) => {
      const previous = legacyConfig();
      const provider = expectDefined(previous.models?.providers?.["local-fixture"], "provider");
      const model = expectDefined(provider.models[0], "model");
      if (id === "non-selected-dynamic-row") {
        provider.models.push({ ...model, id: "${LATER_MODEL}" });
      } else {
        model.id = id;
      }
      const next =
        id === "non-selected-dynamic-row"
          ? previous
          : { ...previous, meta: { migrations: { utilityModelSeparation: true as const } } };
      const { config, changes } = materializeUtilityModelSeparation(next, previous);
      expect(config.agents).toBe(previous.agents);
      expect(hasUtilityModelSeparationMigrationMarker(config)).toBe(false);
      expect(changes).toEqual([]);
      if (id === "non-selected-dynamic-row") {
        expect(config).toBe(previous);
      }
    },
  );

  it.each(["entries", "list"] as const)("migrates enabled %s agents only", (kind) => {
    const entries = {
      worker: { utilityModel: "remote/utility", model: { fallbacks: ["backup/model"] } },
      disabled: { utilityModel: "" },
    };
    const config: OpenClawConfigWithLegacyRoster = {
      agents:
        kind === "entries"
          ? { entries }
          : { list: Object.entries(entries).map(([id, agent]) => Object.assign({ id }, agent)) },
    };
    const migrated = materializeUtilityModelSeparation(config).config;
    const worker =
      kind === "entries" ? migrated.agents?.entries?.worker : migrated.agents?.list?.[0];
    const disabled =
      kind === "entries" ? migrated.agents?.entries?.disabled : migrated.agents?.list?.[1];
    expect(worker?.model).toEqual({
      primary: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
      fallbacks: ["backup/model"],
    });
    expect(disabled).toEqual(
      kind === "list" ? { id: "disabled", utilityModel: "" } : { utilityModel: "" },
    );
    expect(migrated.agents?.defaults?.model).toBeUndefined();
  });

  it.each(["empty-source", "converted", "explicit", "inherited", "agent", "replacement"])(
    "respects primary intent from %s",
    (scope) => {
      const fresh = scope === "empty-source" || scope === "converted";
      let previous: OpenClawConfig = scope === "empty-source" ? {} : legacyConfig();
      if (scope === "converted") {
        previous = materializeUtilityModelSeparation(previous).config;
      } else if (scope === "explicit") {
        previous = { agents: { defaults: { model: "chosen/model" } } };
      }
      if (scope === "empty-source" || scope === "explicit") {
        expect(resolveUtilityModelSeparationError(previous)).toBeUndefined();
      }
      if (scope === "inherited") {
        expectDefined(previous.agents?.defaults, "agent defaults").model =
          "chosen/model@chosen:profile";
      } else if (scope === "agent") {
        expectDefined(previous.agents?.entries?.worker, "worker").model =
          "chosen/model@chosen:profile";
      }
      const next = fresh ? legacyConfig() : structuredClone(previous);
      if (scope === "replacement") {
        expectDefined(next.agents?.defaults, "agent defaults").model =
          "chosen/model@chosen:profile";
      }
      const { config: migrated, changes } = materializeUtilityModelSeparation(next, previous);
      expect(hasUtilityModelSeparationMigrationMarker(migrated)).toBe(true);
      if (fresh) {
        expect(migrated.agents).toBe(next.agents);
        expect(changes).toEqual([]);
        return;
      }
      const model =
        scope === "agent"
          ? migrated.agents?.entries?.worker?.model
          : migrated.agents?.defaults?.model;
      expect(model).toBe(scope === "explicit" ? "chosen/model" : "chosen/model@chosen:profile");
    },
  );

  it.each([
    { meta: "invalid" },
    { meta: { migrations: [] } },
    { meta: { migrations: { utilityModelSeparation: false } } },
    { agents: "invalid" },
    { agents: { defaults: [] } },
    { agents: { defaults: { model: 42 } } },
    { agents: { defaults: { model: { primary: 42 } } } },
    { agents: { entries: { worker: { model: false } } } },
    { agents: { entries: { worker: false } } },
    { agents: { entries: [] } },
    { agents: { list: [{ model: "fixture/model" }] } },
  ])("leaves malformed migration parents for validation: %j", (raw) => {
    const config: Record<string, unknown> = raw;
    expect(materializeUtilityModelSeparation(config)).toEqual({ config, changes: [] });
  });
});
