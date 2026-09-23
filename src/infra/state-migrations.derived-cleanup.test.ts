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
    {
      pluginId: "memory-core",
      migrationId: "memory-core-qmd-workspace-retired",
      label: "retired Memory Core QMD workspace",
    },
    {
      pluginId: "memory-wiki",
      migrationId: "memory-wiki-compiled-cache-file-cleanup",
      label: "rebuildable Memory Wiki compiled cache",
    },
  ])("continues Doctor when $pluginId cleanup fails", async (fixture) => {
    const { stateMigrations } = coercePluginDoctorContractModule(
      await vi.importActual<PluginDoctorContractModule>(
        path.resolve("extensions", fixture.pluginId, "doctor-contract-api.ts"),
      ),
    );
    const stateDir = await tempDirs.make("openclaw-derived-cleanup-");
    const vaultRoot = path.join(stateDir, "vault");
    const qmdHome = path.join(stateDir, "agents", "main", "qmd");
    const artifactPath =
      fixture.pluginId === "memory-core"
        ? path.join(qmdHome, "index.sqlite")
        : path.join(vaultRoot, ".openclaw-wiki", "cache", "agent-digest.json");
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, "rebuildable artifact\n");
    const config: OpenClawConfig = {
      plugins: { entries: { "memory-wiki": { config: { vault: { path: vaultRoot } } } } },
    };
    const env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
    const params = {
      config,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "credentials"),
      context: createPluginDoctorStateMigrationContext({ pluginId: fixture.pluginId, env, config }),
    };
    const migration = expectDefined(
      stateMigrations?.find((entry) => entry.id === fixture.migrationId),
      fixture.migrationId,
    );
    const removalError = new Error("synthetic cleanup permission denied");
    if (fixture.pluginId === "memory-core") {
      const remove = fs.rm;
      vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        if (target === qmdHome) {
          throw removalError;
        }
        await remove(target, options);
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
        id: fixture.migrationId,
        phase: "final",
        source: [{ kind: "path", path: artifactPath }],
        target: [],
        requiredness: "required",
        reversibility: "not-applicable",
      },
      result,
    );

    await expect(fs.readFile(artifactPath, "utf8")).resolves.toBe("rebuildable artifact\n");
    expect(receipt.warnings.join("\n")).toContain(fixture.label);
    expect(receipt.warnings.join("\n")).toContain(removalError.message);
    expect(() => throwIfDoctorStateMigrationRefused([receipt])).not.toThrow();
    expect(receipt.outcome).toBe("warning");
    expect(receipt.warnings.join("\n")).toContain("openclaw doctor --fix");

    vi.restoreAllMocks();
    expect((await migration.migrateLegacyState(params)).warnings).toEqual([]);
    await expect(fs.stat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
