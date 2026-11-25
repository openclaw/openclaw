// Seeded random journeys over every turn kind on openai-completions: each provider request extends the
// previous one byte for byte, except at compaction and a model switch.
import { it } from "vitest";
import { usePrefixRandomizedJourney } from "./prompt-cache-prefix-randomized.test-support.js";

// Seed 4 hits the known silent-turn merge, which each file's seeds must still show.
const { seeds, runJourney } = usePrefixRandomizedJourney("1,4");

for (const seed of seeds) {
  it(`keeps the session prefix append-only for journey seed ${seed}`, { timeout: 600_000 }, () =>
    runJourney("openai-completions", seed),
  );
}
