import {
  curatedSettingsConfigPath,
  type CuratedSettingsPresentation,
} from "./curated-settings-presentation.ts";

/** Admission over the existing synchronous config-form owner; no separate draft. */
export function createCuratedSettingsEditor(
  presentation: CuratedSettingsPresentation,
  owner: {
    read: () => Record<string, unknown> | null;
    parameters: (config: Record<string, unknown> | null) => Readonly<Record<string, string>>;
    canEdit: () => boolean;
    patch: (path: string[], value: unknown) => void;
    remove: (path: string[]) => void;
  },
) {
  return (sectionPath: readonly string[], path: readonly string[], value: unknown) => {
    if (!owner.canEdit()) {
      return;
    }
    const currentPath = curatedSettingsConfigPath(presentation, owner.parameters(owner.read()));
    if (
      currentPath.length !== sectionPath.length ||
      currentPath.some((part, index) => part !== sectionPath[index])
    ) {
      return;
    }
    const target = [...currentPath, ...path];
    if (value === undefined) {
      owner.remove(target);
    } else {
      owner.patch(target, value);
    }
  };
}
