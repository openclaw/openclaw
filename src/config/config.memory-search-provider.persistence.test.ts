// Covers the persisted (on-disk) form of memory-search provider ids.
//
// The config boundary normalizes provider casing in memory (Zod transform), but the
// write path persists the authored projection. An explicitly set provider id must
// therefore land on disk in the same canonical form the runtime resolves, while every
// value this write does not touch must stay byte-identical.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { setConfigValueAtPath } from "./config-paths.js";
import { createConfigIO } from "./io.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

const ROOT_PROVIDER_PATH = ["memory", "search", "provider"] as const;
const AGENT_PROVIDER_PATH = ["agents", "entries", "primary", "memory", "search", "provider"] as const;
const LEGACY_PROVIDER_PATH = ["agents", "entries", "legacy", "memory", "search", "provider"] as const;

function readRawConfig(configPath: string): Promise<Record<string, unknown>> {
  return fs
    .readFile(configPath, "utf8")
    .then((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function stripPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) {
      return current;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function withoutPath(value: unknown, path: readonly string[]): unknown {
  const clone = structuredClone(value) as Record<string, unknown>;
  let parent: Record<string, unknown> = clone;
  for (const segment of path.slice(0, -1)) {
    const next = parent[segment];
    if (typeof next !== "object" || next === null) {
      return clone;
    }
    parent = next as Record<string, unknown>;
  }
  delete parent[path[path.length - 1] as string];
  return clone;
}

/**
 * Drops the write metadata every config write stamps, so a comparison of the written
 * file against the previous one only covers the config content.
 */
function withoutWriteMetadata(value: unknown): unknown {
  const clone = structuredClone(value) as Record<string, unknown>;
  delete clone.meta;
  return clone;
}

describe("memory-search provider persistence", () => {
  it("persists an explicitly set root provider in canonical lowercase form", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
      });
      const io = createConfigIO({
        configPath,
        homedir: () => home,
        pluginValidation: "skip",
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.dirname(configPath),
        },
      });
      const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite({ observe: false });
      expect(snapshot.valid).toBe(true);

      const next = structuredClone(snapshot.sourceConfig) as OpenClawConfig;
      setConfigValueAtPath(next, [...ROOT_PROVIDER_PATH], "None");

      await io.writeConfigFile(next, {
        ...writeOptions,
        observe: false,
        explicitSetPaths: [[...ROOT_PROVIDER_PATH]],
        explicitSetValueSource: next,
      });

      const persisted = await readRawConfig(configPath);
      expect(stripPath(persisted, ROOT_PROVIDER_PATH)).toBe("none");
    });
  });

  it("persists an explicitly set per-agent provider in canonical lowercase form", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        agents: {
          ownership: "explicit",
          entries: {
            primary: { memory: { search: { provider: "NoNe" } } },
            legacy: { memory: { search: { provider: "NoNe" } } },
          },
        },
      });
      const io = createConfigIO({
        configPath,
        homedir: () => home,
        pluginValidation: "skip",
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.dirname(configPath),
        },
      });
      const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite({ observe: false });
      expect(snapshot.valid).toBe(true);
      const before = await readRawConfig(configPath);

      const next = structuredClone(snapshot.sourceConfig) as OpenClawConfig;
      setConfigValueAtPath(next, [...AGENT_PROVIDER_PATH], "NoNe");

      await io.writeConfigFile(next, {
        ...writeOptions,
        observe: false,
        explicitSetPaths: [[...AGENT_PROVIDER_PATH]],
        explicitSetValueSource: next,
      });

      const persisted = await readRawConfig(configPath);
      expect(stripPath(persisted, AGENT_PROVIDER_PATH)).toBe("none");
      // Everything this write did not explicitly set must be byte-identical.
      expect(withoutPath(withoutWriteMetadata(persisted), AGENT_PROVIDER_PATH)).toEqual(
        withoutPath(withoutWriteMetadata(before), AGENT_PROVIDER_PATH),
      );
      // The sibling agent entry keeps its authored casing: the write only canonicalizes
      // the slot it explicitly set, so a legacy value it did not touch is not rewritten.
      expect(stripPath(persisted, LEGACY_PROVIDER_PATH)).toBe("NoNe");
    });
  });
});
