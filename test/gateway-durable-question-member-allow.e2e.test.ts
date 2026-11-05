import { it } from "vitest";
import { runDurableQuestionMemberProof } from "./helpers/durable-question-member.js";

it(
  "recovers an original-store member question before native effects with allow membership",
  { timeout: 180_000 },
  async ({ signal }) => runDurableQuestionMemberProof("allow", signal),
);
