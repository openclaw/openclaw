import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineRetiredPluginStateMigration } from "./doctor-retired-state.js";

describe("retired plugin state admission", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "retired-plugin-state-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  const input = () => ({
    stateDir,
    env: {},
    config: {},
    oauthDir: stateDir,
    context: {
      openPluginStateKeyedStore: () => {
        throw new Error("Retirement must not open canonical state");
      },
    },
  });
  const migration = defineRetiredPluginStateMigration({
    id: "fixture-retired",
    label: "Fixture state",
    intermediateVersion: "2026.9.7",
    findSources: ({ stateDir: root }) => [
      path.join(root, "state.json"),
      { directory: path.join(root, "records"), prefix: "state-", suffix: ".json" },
    ],
  });

  it("refuses Doctor and runtime admission without parsing or changing retired bytes", async () => {
    await expect(migration.detectLegacyState(input())).resolves.toBeNull();
    await expect(migration.assertSupportedState(input())).resolves.toBeUndefined();
    const source = path.join(stateDir, "state.json");
    await fs.writeFile(source, "invalid JSON\n");
    await fs.mkdir(path.join(stateDir, "records"));
    await fs.writeFile(path.join(stateDir, "records", "state-old.json.migrated"), "archive");
    await fs.writeFile(path.join(stateDir, "records", "unrelated.json"), "artifact");
    const detection = await migration.detectLegacyState(input());
    expect(detection?.preview).toEqual([expect.stringContaining("2026.9.7")]);
    expect(detection?.preview[0]).not.toContain("unrelated.json");
    expect(detection?.preview[0]).not.toContain(".migrated");
    await expect(migration.migrateLegacyState(input())).resolves.toEqual({
      changes: [],
      warnings: detection?.preview,
    });
    await expect(migration.assertSupportedState(input())).rejects.toThrow("back it up");
    await expect(fs.readFile(source, "utf8")).resolves.toBe("invalid JSON\n");
    await fs.rename(source, `${source}.saved`);
    await expect(migration.detectLegacyState(input())).resolves.toBeNull();
  });

  it.each(["directory", "symlink"])("refuses a %s without traversing it", async (kind) => {
    const source = path.join(stateDir, "state.json");
    if (kind === "directory") {
      await fs.mkdir(source);
    } else {
      await fs.symlink("missing-target", source);
    }
    await expect(migration.assertSupportedState(input())).rejects.toThrow(source);
    expect((await fs.lstat(source)).isSymbolicLink()).toBe(kind === "symlink");
  });

  it("surfaces inspection errors and checks standalone runtime paths with the same refusal", async () => {
    const failure = Object.assign(new Error("denied"), { code: "EACCES" });
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(failure);
    await expect(migration.detectLegacyState(input())).rejects.toBe(failure);
    const source = path.join(stateDir, "custom-key");
    await fs.writeFile(source, "key bytes");
    await expect(migration.assertSupportedState(input(), [source])).rejects.toThrow("2026.9.7");
    await expect(fs.readFile(source, "utf8")).resolves.toBe("key bytes");
  });
});
