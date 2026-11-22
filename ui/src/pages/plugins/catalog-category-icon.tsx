import type { JSX } from "@solidjs/web";
import { registryCategoryIcon } from "../../components/solid/registry-category-icon.tsx";
import { TemplateCategoryIcon } from "../../components/solid/template-category-icon.tsx";
import type { PluginDiscoveryCategory } from "../../lib/plugins/index.ts";
import { templateCategories } from "../../lib/template-categories.ts";

export function categoryIcon({ slug, icon }: PluginDiscoveryCategory): JSX.Element {
  const template = templateCategories.find(([category]) => category === slug);
  if (template) {
    return <TemplateCategoryIcon icon={template[2]} />;
  }
  return registryCategoryIcon(icon);
}
