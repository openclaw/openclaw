// Seeded random journeys on the opt-out surface (tools.toolSearch: false), where each turn lists
// the tools it builds. Its designed exceptions are in docs/reference/prompt-caching.md.
import { it } from "vitest";
import { usePrefixRandomizedJourney } from "./prompt-cache-prefix-randomized.test-support.js";

const runJourney = usePrefixRandomizedJourney();
const SEEDS = (process.env.OPENCLAW_PREFIX_RANDOM_SEEDS ?? "1,2").split(",").map(Number);

for (const seed of SEEDS) {
  it(`keeps the opt-out prefix append-only for journey seed ${seed}`, { timeout: 600_000 }, () =>
    runJourney("anthropic-messages", seed, { toolSearch: false }),
  );
}
