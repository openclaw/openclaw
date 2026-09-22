import path from "node:path";
import {
  type AgentWorkspaceAccess,
  WorkspaceAccessUnavailableError,
} from "../../agents/workspace-access.js";
import type { SkillInstallSpecMetadata } from "../../plugins/install-security-scan.js";
import { prepareSkillBundle } from "../library/bundle.js";
import type { Skill } from "../loading/skill-contract.js";
import { materializeSkillResources } from "../runtime/resources.js";
import type { SkillEntry, SkillInstallSpec } from "../types.js";

/** Gateway hooks inspect a local source tree, never a path supplied by the workspace host. */
export async function withSkillInstallPolicySource<T>(
  skill: Skill,
  access: AgentWorkspaceAccess | undefined,
  inspect: (sourceDir: string) => Promise<T>,
): Promise<T> {
  if (!access || skill.fileHost === "gateway") {
    return await inspect(path.resolve(skill.baseDir));
  }
  if (!access.skillResources) {
    throw new WorkspaceAccessUnavailableError("Remote skill policy source is unavailable");
  }
  const files = await access.skillResources.readSkillFiles(skill, { allowMissingRoot: false });
  if (!files) {
    throw new WorkspaceAccessUnavailableError("Remote skill policy source disappeared");
  }
  const bundle = prepareSkillBundle(files);
  const source = await materializeSkillResources(
    {
      version: 1,
      skills: [
        { name: skill.name, description: skill.description, revision: bundle.revision, files },
      ],
    },
    () => {},
  );
  try {
    return await inspect(path.join(source.directory, "0"));
  } finally {
    await source.cleanup();
  }
}

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
