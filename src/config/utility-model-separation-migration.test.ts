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
  it("requires canonical conversion before utility provider effects, while allowing fresh and explicit routes", () => {
    const legacy = legacyConfig();
    expect(resolveUtilityModelSeparationError(legacy)).toContain("openclaw doctor --fix");
    expect(
      resolveUtilityModelSeparationError(materializeUtilityModelSeparation(legacy).config),
    ).toBeUndefined();
    expect(resolveUtilityModelSeparationError({})).toBeUndefined();
    expect(
      resolveUtilityModelSeparationError({ agents: { defaults: { model: "chosen/model" } } }),
    ).toBeUndefined();
  });
  it("preserves the shipped implicit primary without changing aliases, profiles, or fallbacks", () => {
    const previous = legacyConfig();
    const original = structuredClone(previous);
    const result = materializeUtilityModelSeparation(previous);

    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "local-fixture/small",
      fallbacks: ["backup/model@backup:account"],
    });
    expect(result.config.agents?.defaults?.utilityModel).toBe("helper@local:utility");
    expect(result.config.agents?.defaults?.models).toEqual(previous.agents?.defaults?.models);
    expect(result.config.agents?.entries).toEqual(previous.agents?.entries);
    expect(result.config.auth).toEqual(previous.auth);
    expect(hasUtilityModelSeparationMigrationMarker(result.config)).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(materializeUtilityModelSeparation(result.config)).toEqual({
      config: result.config,
      changes: [],
    });
    expect(previous).toEqual(original);
  });

  it("uses previous provider ordering before a newly selected utility changes the catalog", () => {
    const previous = legacyConfig();
    const next = legacyConfig();
    next.models = {
      providers: {
        added: {
          baseUrl: "http://127.0.0.1:9/v1",
          models: [
            {
              ...expectDefined(
                previous.models?.providers?.["local-fixture"]?.models[0],
                "local model",
              ),
              id: "new",
            },
          ],
        },
        ...previous.models?.providers,
      },
    };
    const result = materializeUtilityModelSeparation(next, previous);
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "local-fixture/small",
      fallbacks: ["backup/model@backup:account"],
    });
    expect(result.config.models).toBe(next.models);
  });

  it("does not infer a new primary from an empty previous source", () => {
    const next = legacyConfig();
    const result = materializeUtilityModelSeparation(next, {});
    expect(result.config.agents).toBe(next.agents);
    expect(hasUtilityModelSeparationMigrationMarker(result.config)).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it("preserves an unowned built-in default when a utility setup adds a catalog", () => {
    const previous: OpenClawConfig = {
      agents: { defaults: { utilityModel: "remote/utility" }, entries: { worker: {} } },
    };
    const candidate = { ...previous, models: legacyConfig().models };
    const result = materializeUtilityModelSeparation(candidate, previous);
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
    });
    expect(result.config.agents?.defaults?.utilityModel).toBe("remote/utility");
    expect(hasUtilityModelSeparationMigrationMarker(result.config)).toBe(true);
  });

  it.each(["prefix-${LOCAL_MODEL}", "small@experimental"])(
    "defers an unrepresentable legacy model id %s even when a candidate supplies the marker",
    (id) => {
      const previous = legacyConfig();
      expectDefined(previous.models?.providers?.["local-fixture"]?.models[0], "model").id = id;
      const next = { ...previous, meta: { migrations: { utilityModelSeparation: true as const } } };
      const result = materializeUtilityModelSeparation(next, previous);
      expect(result.config.agents).toBe(previous.agents);
      expect(hasUtilityModelSeparationMigrationMarker(result.config)).toBe(false);
      expect(result.changes).toEqual([]);
    },
  );

  it("defers when a non-selected catalog row depends on a future environment value", () => {
    const previous = legacyConfig();
    const provider = expectDefined(previous.models?.providers?.["local-fixture"], "provider");
    provider.models.push({ ...expectDefined(provider.models[0], "model"), id: "${LATER_MODEL}" });
    const result = materializeUtilityModelSeparation(previous);
    expect(result.config).toBe(previous);
    expect(result.changes).toEqual([]);
  });

  it.each(["small@q8_0", "small@20260101"])("preserves a literal supported suffix in %s", (id) => {
    const previous = legacyConfig();
    expectDefined(previous.models?.providers?.["local-fixture"]?.models[0], "model").id = id;
    expect(materializeUtilityModelSeparation(previous).config.agents?.defaults?.model).toEqual({
      primary: `local-fixture/${id}`,
      fallbacks: ["backup/model@backup:account"],
    });
  });

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

  it.each(["inherited", "agent", "replacement"])("preserves an explicit %s primary", (scope) => {
    const previous = legacyConfig();
    if (scope === "inherited") {
      expectDefined(previous.agents?.defaults, "agent defaults").model =
        "chosen/model@chosen:profile";
    } else if (scope === "agent") {
      expectDefined(previous.agents?.entries?.worker, "worker").model =
        "chosen/model@chosen:profile";
    }
    const next = structuredClone(previous);
    if (scope === "replacement") {
      expectDefined(next.agents?.defaults, "agent defaults").model = "chosen/model@chosen:profile";
    }
    const migrated = materializeUtilityModelSeparation(next, previous).config;
    const model =
      scope === "agent"
        ? migrated.agents?.entries?.worker?.model
        : migrated.agents?.defaults?.model;
    expect(model).toBe("chosen/model@chosen:profile");
  });

  it("does not restore a primary deliberately removed from a converted config", () => {
    const previous = materializeUtilityModelSeparation(legacyConfig()).config;
    const next = legacyConfig();
    const result = materializeUtilityModelSeparation(next, previous);
    expect(result.config.agents).toBe(next.agents);
    expect(hasUtilityModelSeparationMigrationMarker(result.config)).toBe(true);
  });

  it("does not trust a candidate marker to bypass preservation of the previous source", () => {
    const previous = legacyConfig();
    const next = { ...previous, meta: { migrations: { utilityModelSeparation: true as const } } };
    expect(
      materializeUtilityModelSeparation(next, previous).config.agents?.defaults?.model,
    ).toEqual({
      primary: "local-fixture/small",
      fallbacks: ["backup/model@backup:account"],
    });
  });

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
