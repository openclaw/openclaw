import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import {
  hasUtilityModelSeparationMigrationMarker,
  materializeUtilityModelSeparation,
  resolveUtilityModelSeparationError,
} from "./utility-model-separation-migration.js";

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
    models: {
      providers: {
        "local-fixture": {
          baseUrl: "http://127.0.0.1:9/v1",
          models: [
            {
              id: "small",
              name: "Local fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        },
      },
    },
    auth: { profiles: { "local:utility": { provider: "local-fixture", mode: "api_key" } } },
  };
}

describe("utility model separation migration", () => {
  it.each([
    "catalog",
    "added-provider",
    "candidate-marker",
    "builtin",
    "small@q8_0",
    "small@20260101",
  ])("preserves the previous implicit primary and unrelated config for %s", (kind) => {
    const previous: OpenClawConfig =
      kind === "builtin"
        ? { agents: { defaults: { utilityModel: "remote/utility" }, entries: { worker: {} } } }
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
          added: {
            baseUrl: "http://127.0.0.1:9/v1",
            models: [
              {
                ...expectDefined(previous.models?.providers?.["local-fixture"]?.models[0], "model"),
                id: "new",
              },
            ],
          },
          ...previous.models?.providers,
        },
      };
    } else if (kind === "candidate-marker") {
      next.meta = { migrations: { utilityModelSeparation: true } };
    } else if (kind === "builtin") {
      next.models = legacyConfig().models;
    }
    const result = materializeUtilityModelSeparation(next, previous);
    expect(resolveUtilityModelSeparationError(result.config)).toBeUndefined();
    expect(result.config.agents?.defaults?.model).toEqual(
      kind === "builtin"
        ? { primary: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}` }
        : {
            primary: `local-fixture/${kind.startsWith("small@") ? kind : "small"}`,
            fallbacks: ["backup/model@backup:account"],
          },
    );
    expect(result.config.agents?.defaults?.utilityModel).toBe(
      previous.agents?.defaults?.utilityModel,
    );
    expect(result.config.agents?.defaults?.models).toEqual(previous.agents?.defaults?.models);
    expect(result.config.agents?.entries).toEqual(previous.agents?.entries);
    expect(result.config.auth).toEqual(previous.auth);
    expect(result.config.models).toBe(next.models);
    expect(hasUtilityModelSeparationMigrationMarker(result.config)).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(materializeUtilityModelSeparation(result.config)).toEqual({
      config: result.config,
      changes: [],
    });
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
      const result = materializeUtilityModelSeparation(next, previous);
      expect(result.config.agents).toBe(previous.agents);
      expect(hasUtilityModelSeparationMigrationMarker(result.config)).toBe(false);
      expect(result.changes).toEqual([]);
      if (id === "non-selected-dynamic-row") {
        expect(result.config).toBe(previous);
      }
    },
  );

  it.each(["entries", "list"] as const)(
    "preserves a per-agent implicit default in a %s roster without promoting disabled utilities",
    (kind) => {
      const agent = { utilityModel: "remote/utility", model: { fallbacks: ["backup/model"] } };
      const config: OpenClawConfig = {
        agents:
          kind === "entries"
            ? { entries: { worker: agent, disabled: { utilityModel: "" } } }
            : {
                list: [
                  { id: "worker", ...agent },
                  { id: "disabled", utilityModel: "" },
                ],
              },
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
      expect(disabled?.model).toBeUndefined();
      expect(disabled?.utilityModel).toBe("");
      expect(migrated.agents?.defaults?.model).toBeUndefined();
    },
  );

  it.each(["empty-source", "converted", "explicit", "inherited", "agent", "replacement"])(
    "respects primary intent from %s",
    (scope) => {
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
      const next =
        scope === "empty-source" || scope === "converted"
          ? legacyConfig()
          : structuredClone(previous);
      if (scope === "replacement") {
        expectDefined(next.agents?.defaults, "agent defaults").model =
          "chosen/model@chosen:profile";
      }
      const result = materializeUtilityModelSeparation(next, previous);
      const migrated = result.config;
      expect(hasUtilityModelSeparationMigrationMarker(migrated)).toBe(true);
      if (scope === "empty-source" || scope === "converted") {
        expect(migrated.agents).toBe(next.agents);
        expect(result.changes).toEqual([]);
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
    const config = raw as unknown as OpenClawConfig;
    expect(materializeUtilityModelSeparation(config)).toEqual({ config, changes: [] });
  });
});
