import type { ThemeCatalogEntry } from "../../../packages/gateway-protocol/src/theme.js";
import { createThemeDefinitionFixture } from "../../../test/helpers/theme-fixture.js";

export function pluginTheme(): ThemeCatalogEntry {
  const definition = createThemeDefinitionFixture({
    mascot: "none",
    workingPhrases: ["Building"],
    critters: ["penguin", "fedora"],
    avatarHat: "fedora",
  });
  return {
    id: "space-pack/xenovessel",
    name: definition.name,
    description: definition.description,
    mascot: definition.mascot,
    workingPhrases: definition.workingPhrases,
    critters: definition.critters,
    avatarHat: definition.avatarHat,
    source: "plugin",
    pluginId: "space-pack",
    modes: ["dark"],
    definition,
  };
}
