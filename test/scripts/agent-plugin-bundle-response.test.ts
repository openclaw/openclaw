import { describe, expect, it } from "vitest";
import { resolveAgentPluginBundleResponse } from "../../scripts/e2e/lib/agent-plugin-bundle-response.mjs";
import { wrapExternalContent } from "../../src/security/external-content.js";

const target = {
  id: "mcp:discovered:weather",
  name: "weather-probe__weather_probe",
  source: "mcp",
};
const controls = ["tool_search", "tool_describe", "dispatch_action"];
const probeText = "probe ok; PLUGIN_ROOT=/fixture; PLUGIN_DATA=/fixture-data; PROBE_MODE=live";
type Round = { name: string; args: Record<string, unknown>; value: unknown };

function targetResult(
  text = probeText,
  details: Partial<{ mcpServer: string; mcpTool: string; status: string }> = {},
) {
  return {
    tool: { ...target },
    result: {
      content: [{ type: "text", text }],
      details: { mcpServer: "weather-probe", mcpTool: "weather_probe", ...details },
    },
  };
}

function rounds(text = probeText): Round[] {
  return [
    { name: "tool_search", args: { query: target.name, limit: 1 }, value: [{ ...target }] },
    {
      name: "tool_describe",
      args: { id: target.id },
      value: {
        ...target,
        parameters: { additionalProperties: false, properties: {}, type: "object" },
      },
    },
    { name: "dispatch_action", args: { id: target.id, args: {} }, value: targetResult(text) },
  ];
}

function request(completed = rounds()) {
  const input: Record<string, unknown>[] = [
    { role: "user", content: "agent plugin bundle qa check" },
    ...completed.flatMap((round, index) => [
      {
        type: "function_call",
        name: round.name,
        call_id: `call_${index}`,
        arguments: JSON.stringify(round.args),
      },
      {
        type: "function_call_output",
        call_id: `call_${index}`,
        output: wrapExternalContent(JSON.stringify(round.value), { source: "api" }),
      },
    ]),
  ];
  return { tools: controls.map((name) => ({ type: "function", name })), input };
}

describe("Agent Plugins bundle mock response", () => {
  it.each([
    [String.raw`C:\Fixture User\plugin=one; two`, String.raw`C:\Fixture User\data=one; two`],
    ["/fixture\nroot", "/fixture\r\ndata"],
  ])(
    "discovers, describes, and calls MCP with dynamic paths %j and %j",
    (pluginRoot, pluginData) => {
      const completed = rounds(
        `probe ok; PLUGIN_ROOT=${pluginRoot}; PLUGIN_DATA=${pluginData}; PROBE_MODE=live`,
      );
      expect(resolveAgentPluginBundleResponse(request([]))).toEqual({
        tool: { name: "tool_search", args: { query: target.name, limit: 1 } },
      });
      expect(resolveAgentPluginBundleResponse(request(completed.slice(0, 1)))).toEqual({
        tool: { name: "tool_describe", args: { id: target.id } },
      });
      expect(resolveAgentPluginBundleResponse(request(completed.slice(0, 2)))).toEqual({
        tool: { name: "dispatch_action", args: { id: target.id, args: {} } },
      });
      expect(resolveAgentPluginBundleResponse(request(completed))).toEqual({
        text: "AGENT_BUNDLE_MCP_OK",
      });
    },
  );

  it.each(controls)("requires the declared %s control", (missing) => {
    const body = request([]);
    body.tools = body.tools.filter((tool) => tool.name !== missing);
    body.input.push({ role: "assistant", content: JSON.stringify({ name: missing }) });
    expect(resolveAgentPluginBundleResponse(body)).toEqual({
      text: "AGENT_BUNDLE_MCP_FAIL tool-not-declared",
    });
  });

  it.each([
    [
      "agent plugin bundle qa check",
      { tool: { name: "tool_search", args: { query: target.name, limit: 1 } } },
    ],
    [
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nCurrent fixture context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      { text: "AGENT_BUNDLE_MCP_OK" },
    ],
  ])("scopes receipts to the current user turn (%s)", (content, expected) => {
    const body = request();
    body.input.push({ role: "user", content });
    expect(resolveAgentPluginBundleResponse(body)).toEqual(expected);
  });

  it.each<[string, (value: Round[]) => void]>([
    ...(
      [
        ["wrong search call", 0, { name: "read" }],
        ["wrong search query", 0, { args: { query: "other", limit: 1 } }],
        ["missing candidate", 0, { value: [] }],
        ["ambiguous candidates", 0, { value: [target, { ...target, id: "other" }] }],
        ["wrong candidate source", 0, { value: [{ ...target, source: "openclaw" }] }],
        ["wrong describe selector", 1, { args: { id: "other" } }],
        [
          "wrong described target",
          1,
          {
            value: {
              ...target,
              id: "other",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          },
        ],
        ["missing described schema", 1, { value: target }],
        ["wrong call selector", 2, { args: { id: "other", args: {} } }],
        ["unexpected target arguments", 2, { args: { id: target.id, args: { unexpected: true } } }],
        [
          "wrong receipt target",
          2,
          { value: { ...targetResult(), tool: { ...target, id: "other" } } },
        ],
        [
          "missing target details",
          2,
          { value: { tool: target, result: { content: [{ type: "text", text: probeText }] } } },
        ],
        ["wrong MCP server", 2, { value: targetResult(probeText, { mcpServer: "other" }) }],
        ["wrong MCP operation", 2, { value: targetResult(probeText, { mcpTool: "other" }) }],
        ["failed target result", 2, { value: targetResult(probeText, { status: "error" }) }],
        ["missing environment evidence", 2, { value: targetResult("probe ok") }],
        [
          "corrupted probe success field",
          2,
          { value: targetResult(probeText.replace("probe ok", "probe ok=false")) },
        ],
        [
          "corrupted probe mode field",
          2,
          { value: targetResult(probeText.replace("PROBE_MODE=live", "PROBE_MODE=live-corrupt")) },
        ],
        ["LF-suffixed probe mode field", 2, { value: targetResult(`${probeText}\n`) }],
      ] satisfies [string, number, Partial<Round>][]
    ).map(([label, index, patch]): [string, (value: Round[]) => void] => [
      label,
      (value) => {
        value[index] = { ...value[index]!, ...patch };
      },
    ]),
    ...(
      [
        [
          "unexpected required arguments",
          { type: "object", properties: {}, additionalProperties: false, required: ["city"] },
        ],
        [
          "unexpected properties",
          { type: "object", properties: { city: { type: "string" } }, additionalProperties: false },
        ],
        [
          "permissive additional properties",
          { type: "object", properties: {}, additionalProperties: true },
        ],
        ["missing additional-property restriction", { type: "object", properties: {} }],
      ] satisfies [string, Record<string, unknown>][]
    ).map(([label, parameters]): [string, (value: Round[]) => void] => [
      label,
      (value) => {
        value.splice(2);
        value[1]!.value = { ...target, parameters };
      },
    ]),
    [
      "extra invocation",
      (value) => {
        value.push({ ...value[2]! });
      },
    ],
  ])("rejects %s even when success markers are present", (_label, corrupt) => {
    const completed = rounds();
    corrupt(completed);
    expect(resolveAgentPluginBundleResponse(request(completed))).toEqual({
      text: "AGENT_BUNDLE_MCP_FAIL unexpected-tool-output",
    });
  });

  it.each<[string, (body: ReturnType<typeof request>) => void]>([
    ...[0, 1, 2].map((index): [string, (body: ReturnType<typeof request>) => void] => [
      `unframed ${controls[index]} output`,
      (body) => {
        body.input[2 + index * 2]!.output = JSON.stringify(rounds()[index]!.value);
      },
    ]),
    [
      "description issued before search completion",
      (body) => {
        body.input.splice(1, 3, body.input[3]!, body.input[1]!, body.input[2]!);
      },
    ],
    [
      "unpaired output",
      (body) => {
        body.input[6]!.call_id = "unrelated";
      },
    ],
    [
      "result before its call",
      (body) => {
        [body.input[5], body.input[6]] = [body.input[6]!, body.input[5]!];
      },
    ],
    [
      "duplicate call identity",
      (body) => {
        body.input.splice(5, 0, { ...body.input[5]! });
      },
    ],
    [
      "outer error",
      (body) => {
        body.input[6]!.isError = true;
      },
    ],
    [
      "mismatched external boundary",
      (body) => {
        body.input[6]!.output = String(body.input[6]!.output).replace(
          /END_EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9])/u,
          (_match, digit: string) =>
            `END_EXTERNAL_UNTRUSTED_CONTENT id="${digit === "0" ? "1" : "0"}`,
        );
      },
    ],
  ])("rejects %s", (_label, corrupt) => {
    const body = request();
    corrupt(body);
    expect(resolveAgentPluginBundleResponse(body)).toEqual({
      text: "AGENT_BUNDLE_MCP_FAIL unexpected-tool-output",
    });
  });
});
