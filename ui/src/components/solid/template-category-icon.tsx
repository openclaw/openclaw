import type { templateCategories } from "../../lib/template-categories.ts";
import { Icon, IconSvg } from "./icon.tsx";

export function TemplateCategoryIcon(props: { icon: (typeof templateCategories)[number][2] }) {
  return typeof props.icon === "string" ? (
    <Icon name={props.icon} />
  ) : (
    <IconSvg data={props.icon} />
  );
}
