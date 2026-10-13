import type { TemplateResult } from "lit";
import { iconData, type IconName } from "./icon-data.ts";
import { renderIconRegistry } from "./icons-tools.ts";

export const icons = renderIconRegistry(iconData);

export type { IconName } from "./icon-data.ts";

export function icon(name: IconName): TemplateResult {
  return icons[name];
}
