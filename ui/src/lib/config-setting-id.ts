/** A setting ID taken from a config path; only {@link configSettingId} makes one. */
export type ConfigSettingPath = string & { readonly configSettingPath: true };

/**
 * ID of one schema setting: its config path, such as `gateway.publicOrigin`. It is the row's
 * element ID and the anchor a settings link names. A section root is addressed by its
 * `config-section-*` ID, and list items share their list's path, so neither has one.
 */
export function configSettingId(path: Array<string | number>): ConfigSettingPath | undefined {
  if (path.length < 2 || path.some((segment) => typeof segment !== "string")) {
    return undefined;
  }
  // SAFETY: a joined config path of string segments is what the brand names.
  return path.join(".") as ConfigSettingPath;
}

/** ID of the element that names a setting row; a marked row is labelled by it. */
export function configSettingTitleId(path: Array<string | number>): string | undefined {
  const id = configSettingId(path);
  return id && `${id}-title`;
}

/** Config section a setting ID belongs to; null for anchors that are not setting IDs. */
export function configSettingSection(settingId: string | null): string | null {
  const separator = settingId?.indexOf(".") ?? -1;
  return settingId && separator > 0 ? settingId.slice(0, separator) : null;
}
