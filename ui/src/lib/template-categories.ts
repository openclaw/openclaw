import type { IconName } from "../components/icon-data.ts";

// ClawHub's current Template taxonomy. The "other" bucket is assigned by ClawHub.
export const templateCategories = [
  ["", "templatesCatalog.categoryAll", "layoutGrid"],
  ["personal", "templatesCatalog.categoryPersonal", "home"],
  ["health", "templatesCatalog.categoryHealth", "heartPulse"],
  ["travel", "templatesCatalog.categoryTravel", "plane"],
  ["productivity", "templatesCatalog.categoryProductivity", "listTodo"],
  ["research", "templatesCatalog.categoryResearch", "search"],
  ["engineering", "templatesCatalog.categoryEngineering", "codeXml"],
  ["governance", "templatesCatalog.categoryGovernance", "scale"],
  ["operations", "templatesCatalog.categoryOperations", "workflow"],
  ["finance", "templatesCatalog.categoryFinance", "coins"],
  ["sales", "templatesCatalog.categorySales", "handshake"],
  ["product", "templatesCatalog.categoryProduct", "lightbulb"],
  ["people", "templatesCatalog.categoryPeople", "users"],
  ["other", "templatesCatalog.categoryOther", "shapes"],
] as const satisfies readonly (readonly [string, string, IconName])[];
