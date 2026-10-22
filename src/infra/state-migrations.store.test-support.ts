import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import {
  coercePluginDoctorContractModule,
  type PluginDoctorContractModule,
  type PluginDoctorStateMigration,
} from "../plugins/doctor-contract-module.js";

export const expectFile = (file: string, contents: string) =>
  expect(fs.readFile(file, "utf8")).resolves.toBe(contents);
export const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });

export async function writeFiles(root: string, files: Record<string, string>) {
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
}

export async function expectFiles(root: string, files: Record<string, string>) {
  for (const [file, contents] of Object.entries(files)) {
    await expectFile(path.join(root, file), contents);
  }
}

export async function runPluginMigrations(
  pluginId: "discord" | "telegram",
  input: Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0],
) {
  const { stateMigrations } = coercePluginDoctorContractModule(
    await vi.importActual<PluginDoctorContractModule>(
      fileURLToPath(
        new URL(`../../extensions/${pluginId}/doctor-contract-api.ts`, import.meta.url),
      ),
    ),
  );
  const results = [];
  for (const migration of stateMigrations) {
    if (await migration.detectLegacyState(input)) {
      results.push({ id: migration.id, result: await migration.migrateLegacyState(input) });
    }
  }
  return results;
}
