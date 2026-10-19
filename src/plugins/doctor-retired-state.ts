import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import type { PluginDoctorStateMigration } from "./doctor-contract-module.js";

type StateLocation = Pick<
  Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0],
  "config" | "env" | "stateDir" | "serviceWorkspaceDir"
>;
type StateSource = string | { directory: string; prefix?: string; suffix: string };

/** Candidate-packaged, read-only retirement checks bound to installed migration identities. */
export type PluginStateRetentionContract = {
  packageName: string;
  stateMigrations: readonly Pick<
    ReturnType<typeof defineRetiredPluginStateMigration>,
    "id" | "assertSupportedState"
  >[];
};

/** Refuses retired files without parsing, importing, or removing their contents. */
export function defineRetiredPluginStateMigration(params: {
  id: string;
  label: string;
  intermediateVersion: string;
  recoveryInstructions?: string;
  findSources: (input: StateLocation) => readonly StateSource[] | Promise<readonly StateSource[]>;
}): PluginDoctorStateMigration & {
  assertSupportedState(input: StateLocation, sources?: readonly StateSource[]): Promise<void>;
} {
  const inspect = async (input: StateLocation, candidates?: readonly StateSource[]) => {
    const sources: string[] = [];
    for (const source of candidates ?? (await params.findSources(input))) {
      const sourcePath = typeof source === "string" ? source : source.directory;
      try {
        const stat = await fs.lstat(sourcePath);
        if (typeof source === "string" || !stat.isDirectory()) {
          sources.push(sourcePath);
          continue;
        }
        for (const name of await fs.readdir(sourcePath)) {
          if (name.startsWith(source.prefix ?? "") && name.endsWith(source.suffix)) {
            sources.push(path.join(sourcePath, name));
          }
        }
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
    return [...new Set(sources)].toSorted();
  };
  const describe = (sources: readonly string[]) =>
    `${params.label} uses a retired pre-July 2026 format: ${sources.join(", ")}. ` +
    `Install OpenClaw ${params.intermediateVersion}. ${params.recoveryInstructions ?? "Run openclaw doctor --fix before upgrading to latest."} ` +
    "Retired files were left untouched. If the intermediate Doctor retains a listed file, verify its migration or recovery needs, back it up, and move it out of the active state directory before retrying.";
  const warnings = async (input: StateLocation, candidates?: readonly StateSource[]) => {
    const sources = await inspect(input, candidates);
    return sources.length ? [describe(sources)] : [];
  };
  return {
    id: params.id,
    label: params.label,
    collectBackupResources: async (input) =>
      (await inspect(input)).map((source) => ({ path: source, kind: "file" as const })),
    async detectLegacyState(input) {
      const preview = await warnings(input);
      return preview.length ? { preview } : null;
    },
    async migrateLegacyState(input) {
      return { changes: [], warnings: await warnings(input) };
    },
    async assertSupportedState(input, candidates) {
      const found = await warnings(input, candidates);
      if (found.length) {
        throw new Error(found.join("\n"));
      }
    },
  };
}
