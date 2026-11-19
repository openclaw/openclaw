// One session through every mid-session trigger on anthropic-messages: each provider request must extend
// the previous one byte for byte, except at the explicit compaction.
import { it } from "vitest";
import { usePrefixStabilityJourney } from "./prompt-cache-prefix-stability.test-support.js";

const runJourney = usePrefixStabilityJourney();

it(
  "keeps one session prefix append-only through every trigger until compaction",
  { timeout: 400_000 },
  () => runJourney("anthropic-messages"),
);
