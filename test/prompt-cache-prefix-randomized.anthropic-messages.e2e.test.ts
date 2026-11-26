// Seeded random journeys over every turn kind on anthropic-messages: each provider request extends the
// previous one byte for byte, except at compaction and a model switch.
import { it } from "vitest";
import { usePrefixRandomizedJourney } from "./prompt-cache-prefix-randomized.test-support.js";

// Seed 6 hits the known skill-list change after a config reload, which each file's seeds must show.
const { seeds, runJourney } = usePrefixRandomizedJourney("1,6");

for (const seed of seeds) {
  it(`keeps the session prefix append-only for journey seed ${seed}`, { timeout: 600_000 }, () =>
    runJourney("anthropic-messages", seed),
  );
}
