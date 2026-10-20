import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("Doctor derived artifact cleanup", () => {
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
    const qmdHome = path.join(stateDir, "agents", "main", "qmd");
    const artifactPath =
      pluginId === "memory-core"
        ? qmdHome
        : path.join(vaultRoot, ".openclaw-wiki", "cache", "agent-digest.json");
    if (pluginId === "memory-core") {
      await fs.mkdir(qmdHome, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(artifactPath), { recursive: true });
      await fs.writeFile(artifactPath, "rebuildable artifact\n");
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
    if (pluginId === "memory-core") {
      const remove = fs.rmdir;
      vi.spyOn(fs, "rmdir").mockImplementation(async (target) => {
        if (target === qmdHome) {
          throw removalError;
        }
        await remove(target);
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

    const result = await migration.migrateLegacyState(params);
    const receipt = createLegacyStateMigrationStepReceipt(
      {
        id: migrationId,
        phase: "final",
        source: [{ kind: "path", path: artifactPath }],
        target: [],
        requiredness: "required",
        reversibility: "not-applicable",
      },
      result,
    );

    if (pluginId === "memory-core") {
      await expect(fs.readdir(qmdHome)).resolves.toEqual([]);
    } else {
      await expect(fs.readFile(artifactPath, "utf8")).resolves.toBe("rebuildable artifact\n");
    }
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
});
