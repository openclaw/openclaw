// Seeded random journeys on the opt-out surface (tools.toolSearch: false), where each turn lists
// the tools it builds. Its designed exceptions are in docs/reference/prompt-caching.md.
import { it } from "vitest";
import { usePrefixRandomizedJourney } from "./prompt-cache-prefix-randomized.test-support.js";

const { seeds, runJourney } = usePrefixRandomizedJourney("1,2");

for (const seed of seeds) {
  it(`keeps the opt-out prefix append-only for journey seed ${seed}`, { timeout: 600_000 }, () =>
    runJourney("anthropic-messages", seed, { toolSearch: false }),
  );
}
