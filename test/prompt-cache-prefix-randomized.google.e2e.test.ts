// Seeded random journeys over every turn kind on google-generative-ai: each provider request extends the
// previous one byte for byte, except at compaction and a model switch.
import { it } from "vitest";
import { usePrefixRandomizedJourney } from "./prompt-cache-prefix-randomized.test-support.js";

const { seeds, runJourney } = usePrefixRandomizedJourney("1,2");

for (const seed of seeds) {
  it(`keeps the session prefix append-only for journey seed ${seed}`, { timeout: 600_000 }, () =>
    runJourney("google-generative-ai", seed),
  );
}
