import { strokePathData, type IconData } from "../components/icon-data-types.ts";
import type { IconName } from "../components/icon-data.ts";

// Lucide popcorn (ISC). Keep catalog-only artwork out of the shared startup icon registry.
const popcornIcon = strokePathData(
  "M18 8a2 2 0 0 0 0-4 2 2 0 0 0-4 0 2 2 0 0 0-4 0 2 2 0 0 0-4 0 2 2 0 0 0 0 4",
  "M10 22 9 8",
  "m14 22 1-14",
  "M20 8c.5 0 .9.4.8 1l-2.6 12c-.1.5-.7 1-1.2 1H7c-.6 0-1.1-.4-1.2-1L3.2 9c-.1-.6.3-1 .8-1Z",
);

// ClawHub's current Template taxonomy. The "other" bucket is assigned by ClawHub.
export const templateCategories = [
  ["", "templatesCatalog.categoryAll", "layoutGrid"],
  ["engineering", "templatesCatalog.categoryEngineering", "codeXml"],
  ["operations", "templatesCatalog.categoryOperations", "workflow"],
  ["household", "templatesCatalog.categoryHousehold", "home"],
  ["entertainment", "templatesCatalog.categoryEntertainment", popcornIcon],
  ["travel", "templatesCatalog.categoryTravel", "plane"],
  ["productivity", "templatesCatalog.categoryProductivity", "listTodo"],
  ["research", "templatesCatalog.categoryResearch", "search"],
  ["health", "templatesCatalog.categoryHealth", "heartPulse"],
  ["sales", "templatesCatalog.categorySales", "handshake"],
  ["product", "templatesCatalog.categoryProduct", "lightbulb"],
  ["other", "templatesCatalog.categoryOther", "shapes"],
] as const satisfies readonly (readonly [string, string, IconName | IconData])[];
