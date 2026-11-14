import assert from "node:assert/strict";
import { stripAssistantMediaDirectivesForDisplay } from "./chat-display-projection.helpers.ts";
import { createLiveAssistantTextProjection } from "./live-chat-projector.ts";

// Acceptance: managed replies must settle to the canonical output with bounded parser work;
// unmanaged and media-free controls must preserve their output and avoid repeated parsing.
const prose =
  "The quick brown fox jumps over the lazy dog while the operator reviews the dashboard. ";
const half = prose.repeat(Math.ceil((64 * 1024) / prose.length));

function run(label: string, source: string) {
  const projection = createLiveAssistantTextProjection({
    managedMediaUrls: ["chart.png"],
  });
  let current = projection.append("");
  const start = process.hrtime.bigint();
  for (let offset = 0; offset < source.length; offset += 4) {
    current = projection.append(source.slice(offset, offset + 4));
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  const expected = stripAssistantMediaDirectivesForDisplay(source, ["chart.png"]);
  assert.equal(current.text, expected, `${label} output must match canonical projection`);
  console.log(
    `${label} chars=${source.length} elapsedMs=${elapsedMs.toFixed(1)} visibleMedia=${current.text.includes("MEDIA:")} canonical=pass`,
  );
}

const whitespaceProjection = createLiveAssistantTextProjection({ managedMediaUrls: ["chart.png"] });
const prefix = "Intro\nMEDIA:chart.png\nDone";
const whitespaceAppend = "\n  \nNext";
whitespaceProjection.append(prefix);
const whitespaceVisible = whitespaceProjection.append(whitespaceAppend).text;
const whitespaceExpected = stripAssistantMediaDirectivesForDisplay(`${prefix}${whitespaceAppend}`, [
  "chart.png",
]);
assert.equal(whitespaceVisible, whitespaceExpected);
assert.equal(whitespaceVisible, "Intro\nDone\n\nNext");
console.log(`whitespace-only-line visible=${JSON.stringify(whitespaceVisible)} canonical=pass`);

for (const sizeKb of [64, 128]) {
  const scaled = prose.repeat(Math.ceil((sizeKb * 1024) / prose.length));
  const source = `${scaled}\n\nMEDIA:chart.png\n\n${scaled}`;
  run(`relative-managed-${sizeKb}k`, source);
}

run("absolute-unmanaged-128k", `${half}\n\nMEDIA:/tmp/chart.png\n\n${half}`);
run("no-media-negative-control-128k", `${half}\n\n${half}`);
