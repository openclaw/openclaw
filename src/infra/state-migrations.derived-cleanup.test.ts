import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  coercePluginDoctorContractModule,
  type PluginDoctorContractModule,
} from "../plugins/doctor-contract-module.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import * as fsSafe from "./fs-safe.js";
import {
  createLegacyStateMigrationStepReceipt,
  throwIfDoctorStateMigrationRefused,
} from "./state-migrations.messages.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

it.each([
  ["memory-core", "memory-core-qmd-workspace-retired", "retired Memory Core QMD workspace"],
  [
    "memory-wiki",
    "memory-wiki-compiled-cache-file-cleanup",
    "rebuildable Memory Wiki compiled cache",
  ],
])("continues Doctor when %s cleanup fails", async (pluginId, migrationId, label) => {
  const { stateMigrations } = coercePluginDoctorContractModule(
    await vi.importActual<PluginDoctorContractModule>(
      path.resolve("extensions", pluginId, "doctor-contract-api.ts"),
    ),
  );
  const stateDir = await tempDirs.make("openclaw-derived-cleanup-");
  const vaultRoot = path.join(stateDir, "vault");
  const isQmd = pluginId === "memory-core";
  const artifactPath = isQmd
    ? path.join(stateDir, "agents", "main", "qmd")
    : path.join(vaultRoot, ".openclaw-wiki", "cache", "agent-digest.json");
  const artifactText = "rebuildable artifact\n";
  await fs.mkdir(isQmd ? artifactPath : path.dirname(artifactPath), { recursive: true });
  if (!isQmd) {
    await fs.writeFile(artifactPath, artifactText);
  }
  const config: OpenClawConfig = {
    plugins: { entries: { "memory-wiki": { config: { vault: { path: vaultRoot } } } } },
  };
  const env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
  const params = {
    config,
    env,
    stateDir,
    oauthDir: path.join(stateDir, "credentials"),
    context: createPluginDoctorStateMigrationContext({ pluginId, env, config }),
  };
  const migration = expectDefined(
    stateMigrations?.find((entry) => entry.id === migrationId),
    migrationId,
  );
  const removalError = new Error("synthetic cleanup permission denied");
  if (isQmd) {
    const remove = fs.rmdir;
    vi.spyOn(fs, "rmdir").mockImplementation(async (target) => {
      if (target === artifactPath) {
        throw removalError;
      }
      return remove(target);
    });
  } else {
    const openRoot = fsSafe.root;
    vi.spyOn(fsSafe, "root").mockImplementation(async (rootPath, defaults) => {
      const root = await openRoot(rootPath, defaults);
      if (rootPath === vaultRoot) {
        vi.spyOn(root, "remove").mockRejectedValue(removalError);
      }
      return root;
    });
  }

  const receipt = createLegacyStateMigrationStepReceipt(
    {
      id: migrationId,
      phase: "final",
      source: [{ kind: "path", path: artifactPath }],
      target: [],
      requiredness: "required",
      reversibility: "not-applicable",
    },
    await migration.migrateLegacyState(params),
  );

  const survivingArtifact = isQmd ? fs.readdir(artifactPath) : fs.readFile(artifactPath, "utf8");
  await expect(survivingArtifact).resolves.toEqual(isQmd ? [] : artifactText);
  const warnings = receipt.warnings.join("\n");
  expect(warnings).toContain(label);
  expect(warnings).toContain(removalError.message);
  expect(() => throwIfDoctorStateMigrationRefused([receipt])).not.toThrow();
  expect(receipt.outcome).toBe("warning");
  expect(warnings).toContain("openclaw doctor --fix");

  vi.restoreAllMocks();
  expect((await migration.migrateLegacyState(params)).warnings).toEqual([]);
  await expect(fs.stat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
});
