import type { SkillFileHost } from "../loading/skill-file-host.js";
import type { ExplicitSkillSelection, SkillCommandSpec } from "../types.js";

const fileHosts = new WeakMap<SkillCommandSpec, SkillFileHost>();
const selectionFileHosts = new WeakMap<ExplicitSkillSelection, SkillFileHost>();

export function recordSkillCommandFileHost(command: SkillCommandSpec, host: SkillFileHost): void {
  fileHosts.set(command, host);
}

export function resolveSkillCommandFileHost(command: SkillCommandSpec): SkillFileHost | undefined {
  return fileHosts.get(command);
}

export function recordExplicitSkillSelectionFileHost<T extends ExplicitSkillSelection>(
  selection: T,
  host: SkillFileHost,
): T {
  selectionFileHosts.set(selection, host);
  return selection;
}

export function resolveExplicitSkillSelectionFileHost(
  selection: ExplicitSkillSelection,
): SkillFileHost | undefined {
  return selectionFileHosts.get(selection);
}

export function copyExplicitSkillSelectionFileHost<T extends ExplicitSkillSelection>(
  source: ExplicitSkillSelection,
  target: T,
): T {
  const host = resolveExplicitSkillSelectionFileHost(source);
  return host ? recordExplicitSkillSelectionFileHost(target, host) : target;
}
