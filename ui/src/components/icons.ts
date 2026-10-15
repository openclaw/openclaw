import { iconData } from "./icon-data.ts";
import { renderIconRegistry } from "./icons-tools.ts";

export const icons = renderIconRegistry(iconData);

export type { IconName } from "./icon-data.ts";
