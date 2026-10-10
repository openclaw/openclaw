import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { OpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { resolveDoctorProviderRenames } from "./provider-rename-recovery.js";
import { applyProviderRenames } from "./provider-rename.js";
import type { ProviderRename } from "./provider-rename.js";

const declarations: ProviderRename[] = [
  { from: "ollama", to: "ollama-cloud", baseUrl: "https://ollama.com" },
];
const states: OpenClawTestState[] = [];
afterEach(async () => {
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

async function fixture() {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "provider-rename-" });
  states.push(state);
  const original: OpenClawConfig = {
    models: {
      providers: {
        ollama: {
          api: "ollama",
          baseUrl: "https://ollama.com/api/",
          apiKey: { source: "env", provider: "default", id: "OLLAMA_API_KEY" },
          models: [],
        },
      },
    },
    agents: { defaults: { model: "ollama/example" } },
  };
  const migrated = applyProviderRenames(original, declarations).config;
  return {
    original,
    migrated,
    snapshot: { path: state.configPath, parsed: migrated },
  };
}

describe("provider rename recovery", () => {
  it("plans a hosted source without requiring a previous backup", async () => {
    const { original, snapshot } = await fixture();
    expect(resolveDoctorProviderRenames({ config: original, snapshot, declarations })).toEqual({
      renames: declarations,
      warnings: [],
    });
  });

  it("recovers a post-config-write plan from the original provider topology", async () => {
    const { original, migrated, snapshot } = await fixture();
    const bytes = JSON.stringify(original);
    fs.writeFileSync(`${snapshot.path}.bak`, bytes);
    expect(resolveDoctorProviderRenames({ config: migrated, snapshot, declarations })).toEqual({
      renames: declarations,
      warnings: [],
    });
    expect(fs.readFileSync(`${snapshot.path}.bak`, "utf8")).toBe(bytes);
    expect(migrated.models?.providers?.["ollama-cloud"].apiKey).toEqual(
      original.models?.providers?.ollama.apiKey,
    );
  });

  it("looks past equivalent backups but never past an intervening provider edit", async () => {
    const { original, migrated, snapshot } = await fixture();
    fs.writeFileSync(`${snapshot.path}.bak`, JSON.stringify(migrated));
    fs.writeFileSync(`${snapshot.path}.bak.1`, JSON.stringify(original));
    expect(
      resolveDoctorProviderRenames({ config: migrated, snapshot, declarations }).renames,
    ).toEqual(declarations);
    const changed = structuredClone(migrated);
    changed.models!.providers!["ollama-cloud"].baseUrl = "https://other.example";
    fs.writeFileSync(`${snapshot.path}.bak`, JSON.stringify(changed));
    expect(
      resolveDoctorProviderRenames({ config: migrated, snapshot, declarations }).renames,
    ).toEqual([]);
  });

  it("does not reinterpret a local daemon or historical includes as a hosted source", async () => {
    const { original, migrated, snapshot } = await fixture();
    const local = structuredClone(original);
    local.models!.providers!.ollama.baseUrl = "http://127.0.0.1:11434";
    fs.writeFileSync(`${snapshot.path}.bak`, JSON.stringify(local));
    expect(
      resolveDoctorProviderRenames({ config: migrated, snapshot, declarations }).renames,
    ).toEqual([]);
    fs.writeFileSync(`${snapshot.path}.bak`, JSON.stringify({ $include: "old.json" }));
    fs.writeFileSync(`${snapshot.path}.bak.1`, JSON.stringify(original));
    expect(
      resolveDoctorProviderRenames({ config: migrated, snapshot, declarations }).renames,
    ).toEqual([]);
  });

  it("reports unreadable history without inventing a migration", async () => {
    const { migrated, snapshot } = await fixture();
    fs.writeFileSync(`${snapshot.path}.bak`, "{broken");
    const result = resolveDoctorProviderRenames({ config: migrated, snapshot, declarations });
    expect(result.renames).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("provider model-reference migration recovery");
  });
});
