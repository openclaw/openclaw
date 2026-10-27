import { describe, expect, it } from "vitest";
import { userFacingTextFilters } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { assistantVisibleTextFilters } from "./assistant-visible-text.js";
import {
  applyTextFilters,
  createTextProjection,
  trimTextFilter,
  type TextFilter,
} from "./text-projection.js";
import { toolCallXmlTextFilter } from "./tool-call-xml.js";

const call = '<tool_call>{"name":"read","arguments":{"path":"a.md"}}</tool_call>';
const nestedCall =
  '<function_calls><invoke name="read"><parameter name="path">a.md</parameter></invoke></function_calls>';
const imageReference = 'See ![`x: <invoke name="x">{"a":1}</invoke>`][ref] now.\n\nNext.\n\n';

const documents = [
  ["complete call", `Before.\n${call}\nAfter.\n`],
  ["partial opener", "Before.\n<tool_ca"],
  ["partial attribute", 'Before.\n<invoke name="read'],
  ["partial closer after ordinary markup", "<div>x</function_calls>"],
  ["truncated closer", '<tool_call>{"name":"read"}</tool_call'],
  ["quoted tag boundary", 'Before </invoke note="a>b">After'],
  ["XML payload", `${nestedCall}\nAfter.\n`],
  ["adjacent response", `${nestedCall}<function_response id="1">ok</function_response>\nAfter.`],
  ["list", `- Before.\n  ${nestedCall}\n  After.\n`],
  ["quote", `> Before.\n> ${nestedCall}\n> After.\n`],
  ["nested quote and list", `> - Before.\n>   ${nestedCall}\n>   After.\n`],
  ["table", `| Before | ${call} |\n| --- | --- |\n| x | After |\n`],
  ["invalidated table", `| Before | \`${call}\` |\n| --- | ---x |\n`],
  ["CRLF", `> Before.\r\n> ${nestedCall}\r\n> After.\r\n`],
  ["standalone parameter", '<parameter name="path">\na.md\n</parameter>\nAfter.'],
  ["generic XML parent", '<example>\n<parameter name="path">a.md</parameter>\n</example>'],
  ["dangling generic XML parent", '<example>\n<parameter name="path">a.md</parameter>'],
  ["self-closing parameter", 'Before <parameter name="path" value="a.md" /> After.'],
  [
    "namespaced call",
    '<antml:invoke name="read"><antml:parameter name="path">a.md</antml:parameter></antml:invoke>',
  ],
  ["fenced code", `\`\`\`xml\n${nestedCall}\n\`\`\`\nAfter.\n`],
  ["mixed model marker", `<|assistant|>Before.\n${call}\nAfter.\n`],
] as const;

// Retain the contributor's append boundaries: later bytes can change an earlier
// XML payload or grant Markdown ownership without introducing another tag.
const transitions = [
  ["XML removal exposes a partial parameter", ["<para<tool_call/>", "meter/>"]],
  ["exposed generic closer", ["<div><parameter>x</parameter></<tool_call/>", "div>"]],
  [
    "exposed image/reference",
    ["!<tool_call/>[example `<parameter>x</parameter>`][ref]\n\n<tool_call/>[re", "f]: /u"],
  ],
  ["exposed link title", ['[a]<tool_call>{}</tool_call>(/ "title `<parameter/>` tail', '")']],
  ["late code closer", ["Use `<parameter/>x", "`."]],
  ["partial JSON attributes", ["<tool_call> name=", '"exec" {"command":"ls"}']],
  ["partial bracket attributes", ['<function_calls> name="read_file" ', '[{"path":"a.md"}]']],
  ["quoted greater-than", ['Before </invoke note="a>b', '">After']],
  ["late image reference", [imageReference, "[ref]: /u\n"]],
  ["split image reference", [imageReference, "[re", "f]: /u\n"]],
] as const;

const configurations: Array<[string, readonly TextFilter[]]> = [
  [
    "streaming XML",
    [toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true)],
  ],
  ["user-facing XML", [toolCallXmlTextFilter({ stripFunctionCallsXmlPayloads: true })]],
  [
    "delivery composition",
    [
      ...assistantVisibleTextFilters("final-answer-delivery", true),
      ...userFacingTextFilters(false, true),
      trimTextFilter("both", { preserveCodeIndentation: true }),
    ],
  ],
];

function expectCanonicalPrefixes(chunks: readonly string[], filters: readonly TextFilter[]) {
  const stream = createTextProjection(filters);
  let source = "";
  let delivered = "";
  for (const chunk of chunks) {
    source += chunk;
    const result = stream.append(chunk);
    delivered = result.delta === null ? result.text : delivered + result.delta;
    const expected = applyTextFilters(source, filters);
    expect(result.text, `source: ${JSON.stringify(source)}`).toBe(expected);
    expect(delivered, `replayed source: ${JSON.stringify(source)}`).toBe(expected);
  }
}

describe.each(configurations)("%s", (_configuration, filters) => {
  it.each(documents)("matches canonical output at every prefix: %s", (_name, source) => {
    for (const size of [1, 4]) {
      const chunks = Array.from({ length: Math.ceil(source.length / size) }, (_, index) =>
        source.slice(index * size, (index + 1) * size),
      );
      expectCanonicalPrefixes(chunks, filters);
    }
  });

  it.each(transitions)("re-evaluates the reported %s transition", (_name, chunks) => {
    expectCanonicalPrefixes(chunks, filters);
  });
});

it.each([
  ["<tool_call> a=b{", ""],
  ["<tool_call> a=xyz[", ""],
  ["<tool_call> a={", "<tool_call> a={"],
  ["<tool_call> a={x{", ""],
])("preserves unquoted attribute payload recognition: %s", (source, expected) => {
  for (const streaming of [false, true]) {
    expect(toolCallXmlTextFilter({}, streaming).transform(source)).toBe(expected);
  }
});
