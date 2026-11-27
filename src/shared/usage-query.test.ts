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

it("reads doubled quotes in a value and leaves handwritten backslashes literal", () => {
  const query = String.raw`model:"C:\models\Atlas ""Mini""" tool:\\host\tool label:"path with spaces\"`;
  expect(extractQueryTerms(query).map((term) => term.value)).toEqual([
    String.raw`C:\models\Atlas "Mini"`,
    String.raw`\\host\tool`,
    "path with spaces\\",
  ]);
});
