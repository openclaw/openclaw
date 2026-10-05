import path from "node:path";
import {
  UpdateCandidateDatabaseMappingSchema,
  UpdateStateSchemaVersionsSchema,
  type UpdateCandidateDatabaseMapping,
  type UpdateStateSchemaVersion,
} from "./update-candidate-state.js";

export type UpdateCandidateRehearsalStateObservation = {
  sourceStateVersions: UpdateStateSchemaVersion[];
  stateVersions: UpdateStateSchemaVersion[];
};

/** Consume the snapshot writer's exact alias-to-physical-copy manifest, never invert hashes. */
export function projectUpdateCandidateStateObservation(
  privateStateRoot: string,
  mappings: readonly UpdateCandidateDatabaseMapping[],
  sourceStateVersions: readonly UpdateStateSchemaVersion[],
  privateStateVersions: readonly UpdateStateSchemaVersion[],
): UpdateCandidateRehearsalStateObservation {
  const source = UpdateStateSchemaVersionsSchema.parse(sourceStateVersions);
  const observed = UpdateStateSchemaVersionsSchema.parse(privateStateVersions);
  const selected = new Map<string, string>();
  const privatePaths = new Set<string>();
  for (const value of mappings) {
    const mapping = UpdateCandidateDatabaseMappingSchema.parse(value);
    const relative = path.relative(privateStateRoot, mapping.privatePath);
    if (
      !path.isAbsolute(mapping.privatePath) ||
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Rehearsal database mapping escaped its exact private snapshot root.");
    }
    if (selected.has(mapping.sourcePath)) {
      throw new Error("Rehearsal database mapping repeats a source locator.");
    }
    selected.set(mapping.sourcePath, mapping.privatePath);
    privatePaths.add(mapping.privatePath);
  }
  if (selected.size !== source.length || source.some((entry) => !selected.has(entry.path))) {
    throw new Error(
      "Rehearsal database mapping differs from its retained source snapshot inventory.",
    );
  }
  const current = new Map<string, Omit<UpdateStateSchemaVersion, "path">>();
  for (const { path: privatePath, ...version } of observed) {
    if (!privatePaths.has(privatePath) || current.has(privatePath)) {
      throw new Error("Rehearsal observed an unmapped or duplicate private database locator.");
    }
    current.set(privatePath, version);
  }
  if (current.size !== privatePaths.size) {
    throw new Error(
      "Rehearsal did not observe every retained private database; absence cannot be inferred.",
    );
  }
  const stateVersions = source.map((entry) => {
    const privatePath = selected.get(entry.path)!;
    return Object.assign({ path: entry.path }, current.get(privatePath)!);
  });
  return { sourceStateVersions: source, stateVersions };
}
