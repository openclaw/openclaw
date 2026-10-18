import type { ApplicationConfigCapability } from "../app/config.ts";
import { t } from "../i18n/index.ts";

/** Read the live bootstrap projection, including in handlers retained across a refresh. */
export function uploadsEnabled(config?: ApplicationConfigCapability): boolean {
  return config?.current.uploadsEnabled !== false;
}

export function uploadsDisabledMessage(): string {
  return t("common.uploadsDisabled");
}

export function assertUploadsEnabled(config?: ApplicationConfigCapability): void {
  if (!uploadsEnabled(config)) {
    throw new Error(uploadsDisabledMessage());
  }
}
