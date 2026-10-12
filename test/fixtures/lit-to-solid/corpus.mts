import fs from "node:fs";

type GoldenTemplate = {
  id: string;
  provenance: { path: string; line: number };
  input: string;
  expected: string;
};

export const corpus: GoldenTemplate[] = JSON.parse(
  fs.readFileSync(new URL("./corpus.json", import.meta.url), "utf8"),
);
const context = fs.readFileSync(new URL("./context.txt", import.meta.url), "utf8");

export function fixtureSource(fixture: GoldenTemplate) {
  return [
    'import { html, svg, nothing } from "lit";',
    'import { styleMap } from "lit/directives/style-map.js";',
    context,
    `export const fixture = ${fixture.input};`,
  ].join("\n");
}
