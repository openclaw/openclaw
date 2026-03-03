import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ScenarioSchema, type Scenario } from "./_schema.js";

const FIXTURE_DIR = new URL(".", import.meta.url).pathname;

/** Load all scenario JSON files from fixtures directory tree. */
export function loadAllScenarios(): Scenario[] {
  const scenarios: Scenario[] = [];
  const categories = readdirSync(FIXTURE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"));

  for (const cat of categories) {
    const catDir = join(FIXTURE_DIR, cat.name);
    const files = readdirSync(catDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(catDir, file), "utf-8"));
      // Handle both single scenario and array of scenarios
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        scenarios.push(ScenarioSchema.parse(item));
      }
    }
  }
  return scenarios;
}

/** Filter scenarios by tags. */
export function filterByTags(scenarios: Scenario[], tags: string[]): Scenario[] {
  return scenarios.filter((s) => tags.some((t) => s.tags.includes(t)));
}

/** Filter scenarios by market. */
export function filterByMarket(scenarios: Scenario[], market: string): Scenario[] {
  return scenarios.filter((s) => s.market === market);
}

/** Filter scenarios by category. */
export function filterByCategory(scenarios: Scenario[], category: string): Scenario[] {
  return scenarios.filter((s) => s.category === category);
}

/** Get all unique scenario IDs. */
export function getScenarioIds(scenarios: Scenario[]): string[] {
  return scenarios.map((s) => s.id);
}

/** Get all unique categories. */
export function getCategories(scenarios: Scenario[]): string[] {
  return [...new Set(scenarios.map((s) => s.category))];
}
