/** Bundled host-placement templates, independent of runtime plugin activation. */
/** Display-only fallback: never a JSON Schema default or a config write. */
export type CuratedSettingsDefault =
  | string
  | number
  | boolean
  | {
      scope: "document" | "section";
      path: readonly string[];
      fallbackKey: string;
    };

export type CuratedSettingsField = {
  path: readonly string[];
  labelKey: string;
  helpKey: string;
} & (
  | { kind: "text"; displayDefault: CuratedSettingsDefault }
  | {
      kind: "model";
      displayDefault: CuratedSettingsDefault;
      placeholderKey: string;
      customLabelKey: string;
    }
  | {
      kind: "number";
      displayDefault: number;
      bounds: { integer: boolean; min: number; max?: number };
    }
  | { kind: "toggle"; displayDefault: boolean }
  | {
      kind: "segmented";
      displayDefault: string;
      options: readonly { value: string; labelKey: string }[];
    }
);

export type CuratedSettingsPresentation = {
  id: string;
  /** Source ownership; this is not the selected runtime config owner. */
  presentationOwner: string;
  configPath: readonly (string | { parameter: string })[];
  intro: { messageKey: string; url: string };
  unsupported: { titleKey: string; rowTitleKey: string; descriptionKey: string };
  sections: readonly {
    titleKey: string;
    descriptionKey: string;
    fields: readonly CuratedSettingsField[];
  }[];
};

// Available while disconnected or before the runtime catalog/schema arrives.
// The distinct filename keeps settings templates outside the add-on metadata glob.
const presentations = import.meta.glob<CuratedSettingsPresentation>(
  "../../../../extensions/*/control-ui.settings-presentation.json",
  { eager: true, import: "default" },
);

export function curatedSettingsPresentation(id: string): CuratedSettingsPresentation {
  const presentation = Object.values(presentations).find((item) => item.id === id);
  if (!presentation) {
    throw new Error(`Missing bundled settings presentation: ${id}`);
  }
  return presentation;
}

export function curatedSettingsConfigPath(
  presentation: CuratedSettingsPresentation,
  parameters: Readonly<Record<string, string>>,
): string[] {
  return presentation.configPath.map((part) => {
    if (typeof part === "string") {
      return part;
    }
    const value = parameters[part.parameter];
    if (value === undefined) {
      throw new Error(`Missing settings presentation parameter: ${part.parameter}`);
    }
    return value;
  });
}
