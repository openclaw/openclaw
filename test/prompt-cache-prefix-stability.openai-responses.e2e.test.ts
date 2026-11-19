// One session through every mid-session trigger on openai-responses: each provider request must extend
// the previous one byte for byte, except at the provider's own compaction and the explicit one.
import { it } from "vitest";
import { usePrefixStabilityJourney } from "./prompt-cache-prefix-stability.test-support.js";

const runJourney = usePrefixStabilityJourney();

it(
  "keeps one session prefix append-only through every trigger until compaction",
  { timeout: 400_000 },
  () => runJourney("openai-responses"),
);
