import type { SkillInstallSpecMetadata } from "../../plugins/install-security-scan.js";
import type { SkillEntry, SkillInstallSpec } from "../types.js";

export function normalizeSkillInstallSpec(spec: SkillInstallSpec): SkillInstallSpecMetadata {
  return {
    ...(spec.id ? { id: spec.id } : {}),
    kind: spec.kind,
    ...(spec.label ? { label: spec.label } : {}),
    ...(spec.bins ? { bins: spec.bins.slice() } : {}),
    ...(spec.os ? { os: spec.os.slice() } : {}),
    ...(spec.formula ? { formula: spec.formula } : {}),
    ...(spec.package ? { package: spec.package } : {}),
    ...(spec.module ? { module: spec.module } : {}),
    ...(spec.url ? { url: spec.url } : {}),
    ...(spec.sha256 ? { sha256: spec.sha256 } : {}),
    ...(spec.archive ? { archive: spec.archive } : {}),
    ...(spec.extract !== undefined ? { extract: spec.extract } : {}),
    ...(spec.stripComponents !== undefined ? { stripComponents: spec.stripComponents } : {}),
    ...(spec.targetDir ? { targetDir: spec.targetDir } : {}),
  };
}

function resolveInstallId(spec: SkillInstallSpec, index: number): string {
  return (spec.id ?? `${spec.kind}-${index}`).trim();
}

export function findInstallSpec(
  entry: SkillEntry,
  installId: string,
): SkillInstallSpec | undefined {
  const specs = entry.metadata?.install ?? [];
  for (const [index, spec] of specs.entries()) {
    if (resolveInstallId(spec, index) === installId) {
      return spec;
    }
  }
  return undefined;
}
