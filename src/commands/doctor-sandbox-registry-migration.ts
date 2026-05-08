import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_BROWSERS_DIR,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_REGISTRY_PATH,
} from "../agents/sandbox/constants.js";
import {
  readBrowserRegistry,
  readRegistryEntry,
  updateBrowserRegistry,
  updateRegistry,
  type SandboxBrowserRegistryEntry,
  type SandboxRegistryEntry,
} from "../agents/sandbox/registry.js";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";

type RegistryEntry = {
  containerName: string;
};

type RegistryEntryPayload = RegistryEntry & Record<string, unknown>;

type RegistryFile = {
  entries: RegistryEntryPayload[];
};

type LegacyRegistryKind = "containers" | "browsers";

type LegacyRegistryTarget = {
  kind: LegacyRegistryKind;
  registryPath: string;
  shardedDir: string;
};

export type LegacySandboxRegistryInspection = LegacyRegistryTarget & {
  exists: boolean;
  valid: boolean;
  entries: number;
};

export type LegacySandboxRegistryMigrationResult = LegacyRegistryTarget & {
  status: "missing" | "migrated" | "removed-empty" | "quarantined-invalid";
  entries: number;
  quarantinePath?: string;
};

const RegistryEntrySchema = z
  .object({
    containerName: z.string(),
  })
  .passthrough();

const RegistryFileSchema = z.object({
  entries: z.array(RegistryEntrySchema),
});

async function readLegacyRegistryFile(registryPath: string): Promise<RegistryFile | null> {
  try {
    const raw = await fs.readFile(registryPath, "utf-8");
    const parsed = safeParseJsonWithSchema(RegistryFileSchema, raw) as RegistryFile | null;
    return parsed;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { entries: [] };
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to read sandbox registry file: ${registryPath}`, { cause: error });
  }
}

async function quarantineLegacyRegistry(registryPath: string): Promise<string> {
  const quarantinePath = `${registryPath}.invalid-${Date.now()}`;
  await fs.rename(registryPath, quarantinePath).catch(async (error) => {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      await fs.rm(registryPath, { force: true });
    }
  });
  return quarantinePath;
}

async function legacyShardPaths(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .map((name) => path.join(dir, name));
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readLegacyShardFile(shardPath: string): Promise<RegistryEntryPayload | null> {
  try {
    const raw = await fs.readFile(shardPath, "utf-8");
    return safeParseJsonWithSchema(RegistryEntrySchema, raw) as RegistryEntryPayload | null;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function inspectMonolithicLegacyRegistry(target: LegacyRegistryTarget): Promise<{
  exists: boolean;
  valid: boolean;
  entries: RegistryEntryPayload[];
}> {
  try {
    await fs.access(target.registryPath);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { exists: false, valid: true, entries: [] };
    }
    throw error;
  }

  const registry = await readLegacyRegistryFile(target.registryPath);
  return {
    exists: true,
    valid: Boolean(registry),
    entries: registry?.entries ?? [],
  };
}

async function inspectShardedLegacyRegistry(target: LegacyRegistryTarget): Promise<{
  exists: boolean;
  valid: boolean;
  entries: RegistryEntryPayload[];
  invalidPath?: string;
}> {
  const shardPaths = await legacyShardPaths(target.shardedDir);
  const entries: RegistryEntryPayload[] = [];
  for (const shardPath of shardPaths) {
    const entry = await readLegacyShardFile(shardPath);
    if (!entry) {
      return { exists: true, valid: false, entries, invalidPath: shardPath };
    }
    entries.push(entry);
  }
  return { exists: shardPaths.length > 0, valid: true, entries };
}

async function hasBrowserRegistryEntry(containerName: string): Promise<boolean> {
  const registry = await readBrowserRegistry();
  return registry.entries.some((entry) => entry.containerName === containerName);
}

async function importLegacyRegistryEntry(
  kind: LegacyRegistryKind,
  entry: RegistryEntryPayload,
): Promise<void> {
  if (kind === "containers") {
    if (await readRegistryEntry(entry.containerName)) {
      return;
    }
    await updateRegistry(entry as SandboxRegistryEntry);
    return;
  }
  if (await hasBrowserRegistryEntry(entry.containerName)) {
    return;
  }
  await updateBrowserRegistry(entry as SandboxBrowserRegistryEntry);
}

async function migrateTargetIfNeeded(
  target: LegacyRegistryTarget,
): Promise<LegacySandboxRegistryMigrationResult> {
  const monolithic = await inspectMonolithicLegacyRegistry(target);
  if (!monolithic.valid) {
    const quarantinePath = await quarantineLegacyRegistry(target.registryPath);
    return { ...target, status: "quarantined-invalid", entries: 0, quarantinePath };
  }
  const sharded = await inspectShardedLegacyRegistry(target);
  if (!sharded.valid) {
    const quarantinePath = sharded.invalidPath
      ? await quarantineLegacyRegistry(sharded.invalidPath)
      : undefined;
    return { ...target, status: "quarantined-invalid", entries: 0, quarantinePath };
  }

  if (!monolithic.exists && !sharded.exists) {
    return { ...target, status: "missing", entries: 0 };
  }

  const entries = [...monolithic.entries, ...sharded.entries];
  if (entries.length === 0) {
    await fs.rm(target.registryPath, { force: true });
    await fs.rm(`${target.registryPath}.lock`, { force: true });
    await fs.rm(target.shardedDir, { recursive: true, force: true });
    return { ...target, status: "removed-empty", entries: 0 };
  }

  for (const entry of entries) {
    await importLegacyRegistryEntry(target.kind, entry);
  }

  await fs.rm(target.registryPath, { force: true });
  await fs.rm(`${target.registryPath}.lock`, { force: true });
  await fs.rm(target.shardedDir, { recursive: true, force: true });
  return { ...target, status: "migrated", entries: entries.length };
}

function legacyRegistryTargets(): LegacyRegistryTarget[] {
  return [
    {
      kind: "containers",
      registryPath: SANDBOX_REGISTRY_PATH,
      shardedDir: SANDBOX_CONTAINERS_DIR,
    },
    {
      kind: "browsers",
      registryPath: SANDBOX_BROWSER_REGISTRY_PATH,
      shardedDir: SANDBOX_BROWSERS_DIR,
    },
  ];
}

export async function inspectLegacySandboxRegistryFiles(): Promise<
  LegacySandboxRegistryInspection[]
> {
  const inspections: LegacySandboxRegistryInspection[] = [];
  for (const target of legacyRegistryTargets()) {
    const monolithic = await inspectMonolithicLegacyRegistry(target);
    const sharded = monolithic.valid
      ? await inspectShardedLegacyRegistry(target)
      : { exists: false, valid: true, entries: [] };
    inspections.push({
      ...target,
      exists: monolithic.exists || sharded.exists,
      valid: monolithic.valid && sharded.valid,
      entries: monolithic.entries.length + sharded.entries.length,
    });
  }
  return inspections;
}

export async function migrateLegacySandboxRegistryFiles(): Promise<
  LegacySandboxRegistryMigrationResult[]
> {
  const results: LegacySandboxRegistryMigrationResult[] = [];
  for (const target of legacyRegistryTargets()) {
    results.push(await migrateTargetIfNeeded(target));
  }
  return results;
}
