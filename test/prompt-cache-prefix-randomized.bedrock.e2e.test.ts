// Seeded random journeys over every turn kind on bedrock-converse-stream: each provider request extends the
// previous one byte for byte, except at compaction and a model switch.
import { it } from "vitest";
import { usePrefixRandomizedJourney } from "./prompt-cache-prefix-randomized.test-support.js";

const runJourney = usePrefixRandomizedJourney();
const SEEDS = (process.env.OPENCLAW_PREFIX_RANDOM_SEEDS ?? "1,2").split(",").map(Number);

for (const seed of SEEDS) {
  it(`keeps the session prefix append-only for journey seed ${seed}`, { timeout: 600_000 }, () =>
    runJourney("bedrock-converse-stream", seed),
  );
}
