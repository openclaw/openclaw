import { svg, type TemplateResult } from "lit";
import { guard } from "lit/directives/guard.js";
import { iconData, type IconName } from "./icon-data.ts";
import { renderIconRegistry } from "./icons-tools.ts";

// Unported chat slots still accept Lit templates. Each guard owns one native SVG.
export const icons = Object.fromEntries(
  Object.entries(renderIconRegistry(iconData)).map(([name, renderIcon]) => [
    name,
    svg`${guard([renderIcon], renderIcon)}`,
  ]),
  // SAFETY: Mapping values retains every key of the source-owned registry.
) as Record<IconName, TemplateResult>;
