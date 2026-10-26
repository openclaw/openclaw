import { expect, it } from "vitest";
import { extractQueryTerms } from "./usage-query.js";

it("tokenizes query terms including quoted strings", () => {
  const terms = extractQueryTerms(
    'agent:main "model:gpt-5.2" label:"Team Planning" "label:Team  Planning" "free phrase" has:errors',
  );
  expect(terms).toEqual([
    { key: "agent", value: "main", raw: "agent:main" },
    { key: "model", value: "gpt-5.2", raw: '"model:gpt-5.2"' },
    { key: "label", value: "Team Planning", raw: 'label:"Team Planning"' },
    { key: "label", value: "Team  Planning", raw: '"label:Team  Planning"' },
    { value: "free phrase", raw: '"free phrase"' },
    { key: "has", value: "errors", raw: "has:errors" },
  ]);
});
