import type { TemplateResult } from "lit";
import { iconData } from "./icon-data.ts";
import { createIconTemplates } from "./icons-tools.ts";

export const icons = createIconTemplates(iconData);
export type IconName = keyof typeof icons;

export function icon(name: IconName): TemplateResult {
  return icons[name];
}
