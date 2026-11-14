import { describe, expect, it } from "vitest";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../../agents/embedded-agent-utils.js";
import { expectPrefixParity } from "./streaming.test-support.js";
import { createTextProjection, trimTextPreservingCode } from "./text-projection.js";
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
  ["HTML", "<details><summary>Result</summary><p>ordinary text</p></details>"],
  ["JSX", "<div>{items.length < 3 ? <b>Few</b> : <i>Many</i>}</div>"],
  ["literal comparison", "a < b and x > y; the identifier is <tool_."],
  ["resynchronization", "<\n\na\n\n<"],
  ["resynchronization before a fence", "<`</f\n\n<```"],
  ["adjacent partial tags", "<p<p"],
  ["hidden reasoning before HTML", "<think>synthetic private reasoning</think><p>visible</p>"],
  [
    "stripped memories before a partial tag",
    "<relevant-memories>synthetic private memory</relevant-memories>\n<p",
  ],
  ["tool call after a partial tag", `<p${call}`],
  ["partial tag after a tool call", `${call}<p`],
  ["fenced call followed by HTML", `\`\`\`xml\n${call}\n\`\`\`\n\n<p>visible</p>`],
  ["inline call followed by HTML", `Example \`${call}\`; <p>visible</p>`],
  ["indented partial tag", "Before.\n\n    <p"],
  ["quoted partial tag", "> Before.\n> <p"],
  ["late image ownership", `![example \`x\n${call}\nx\`][id]\n\n[id]: /url\n`],
  ["CRLF fence", `\`\`\`xml\r\n${call}\r\n\`\`\`\r\n<p`],
] as const;

// Retain the contributor's append boundaries: later bytes can change an earlier
// XML payload or grant Markdown ownership without introducing another tag.
const transitions = [
  ["empty append after suppressed XML", ["<\n\na", "", "\n\n<"]],
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

const configurations = ["streaming XML", "user-facing XML", "delivery composition"] as const;

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

describe.each(configurations)("%s", (name) => {
  const filter =
    name === "streaming XML"
      ? toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true)
      : toolCallXmlTextFilter({ stripFunctionCallsXmlPayloads: true });
  const create = () =>
    name === "delivery composition"
      ? createAssistantVisibleStreamText("final_answer")
      : createTextProjection([filter]);
  const transform = (source: string) =>
    name === "delivery composition"
      ? trimTextPreservingCode(sanitizeAssistantVisibleStreamText(source, "final_answer"))
      : filter.transform(source);
  it.each(documents)("matches canonical output at every split: %s", (_name, source) => {
    expectPrefixParity(source, create, transform);
  });
  it.each(transitions)("re-evaluates the reported %s transition", (_name, chunks) => {
    expectPrefixParity(chunks.join(""), create, transform, chunks);
  });
  it.each([
    ["<script>    <", "b"],
    ["After <a", ' href="/x">link</a>'],
    ["<\n\na\n\n<", "p>visible</p>"],
  ])("preserves full delivery parity after a replacement ending in %j", (prefix, tail) => {
    const stream = create();
    stream.append("Discarded draft.");
    const replaced = stream.replace(prefix);
    expect(replaced.text).toBe(transform(prefix));
    if (name === "streaming XML" && prefix !== "<\n\na\n\n<") {
      expect(replaced.text).toBe(prefix.slice(0, prefix.lastIndexOf("<")));
    }
    const appended = stream.append(tail);
    const delivered = appended.delta === null ? appended.text : replaced.text + appended.delta;
    const expected = transform(prefix + tail);
    expect(appended.text).toBe(expected);
    expect(delivered).toBe(expected);
  });
});
