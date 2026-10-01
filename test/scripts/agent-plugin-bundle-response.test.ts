import { describe, expect, it } from "vitest";
import { resolveAgentPluginBundleResponse } from "../../scripts/e2e/lib/agent-plugin-bundle-response.mjs";
import { wrapExternalContent } from "../../src/security/external-content.js";

const target = {
  id: "mcp:discovered:weather",
  name: "weather-probe__weather_probe",
  source: "mcp",
};
const controls = ["tool_search", "tool_describe", "tool_call"];
const probeText = "probe ok; PLUGIN_ROOT=/fixture; PLUGIN_DATA=/fixture-data; PROBE_MODE=live";
type Round = { name: string; args: Record<string, unknown>; value: unknown };

function targetResult() {
  return {
    tool: { ...target },
    result: {
      content: [{ type: "text", text: probeText }],
      details: { mcpServer: "weather-probe", mcpTool: "weather_probe" },
    },
  };
}

function rounds(): Round[] {
  return [
    { name: "tool_search", args: { query: target.name, limit: 1 }, value: [{ ...target }] },
    {
      name: "tool_describe",
      args: { id: target.id },
      value: {
        ...target,
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    { name: "tool_call", args: { id: target.id, args: {} }, value: targetResult() },
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
  it("discovers, describes, and calls the returned MCP identity before accepting its result", () => {
    expect(resolveAgentPluginBundleResponse(request([]))).toEqual({
      tool: { name: "tool_search", args: { query: target.name, limit: 1 } },
    });
    expect(resolveAgentPluginBundleResponse(request(rounds().slice(0, 1)))).toEqual({
      tool: { name: "tool_describe", args: { id: target.id } },
    });
    expect(resolveAgentPluginBundleResponse(request(rounds().slice(0, 2)))).toEqual({
      tool: { name: "tool_call", args: { id: target.id, args: {} } },
    });
    expect(resolveAgentPluginBundleResponse(request())).toEqual({ text: "AGENT_BUNDLE_MCP_OK" });
  });

  it.each(controls)("requires the declared %s control", (missing) => {
    const body = request([]);
    body.tools = body.tools.filter((tool) => tool.name !== missing);
    body.input.push({ role: "assistant", content: JSON.stringify({ name: missing }) });
    expect(resolveAgentPluginBundleResponse(body)).toEqual({
      text: "AGENT_BUNDLE_MCP_FAIL tool-not-declared",
    });
  });

  it("accepts the advertised schema independently of key order", () => {
    const completed = rounds().slice(0, 2);
    completed[1]!.value = {
      ...target,
      parameters: { additionalProperties: false, properties: {}, type: "object" },
    };
    expect(resolveAgentPluginBundleResponse(request(completed))).toEqual({
      tool: { name: "tool_call", args: { id: target.id, args: {} } },
    });
  });

  it.each<[string, Record<string, unknown>]>([
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
  ])("rejects %s before calling the MCP tool", (_label, parameters) => {
    const completed = rounds().slice(0, 2);
    completed[1]!.value = { ...target, parameters };
    expect(resolveAgentPluginBundleResponse(request(completed))).toEqual({
      text: "AGENT_BUNDLE_MCP_FAIL unexpected-tool-output",
    });
  });

  it("starts discovery again instead of accepting a previous turn's receipt", () => {
    const body = request();
    body.input.push({ role: "user", content: "agent plugin bundle qa check" });
    expect(resolveAgentPluginBundleResponse(body)).toMatchObject({ tool: { name: "tool_search" } });
  });

  it("keeps the current turn's receipts when runtime context follows them", () => {
    const body = request();
    body.input.push({
      role: "user",
      content:
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nCurrent fixture context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    });
    expect(resolveAgentPluginBundleResponse(body)).toEqual({ text: "AGENT_BUNDLE_MCP_OK" });
  });

  it.each([
    [String.raw`C:\Fixture User\plugin=one; two`, String.raw`C:\Fixture User\data=one; two`],
    ["/fixture\nroot", "/fixture\r\ndata"],
  ])("preserves dynamic probe paths %j and %j", (pluginRoot, pluginData) => {
    const completed = rounds();
    const result = targetResult();
    result.result.content[0]!.text = `probe ok; PLUGIN_ROOT=${pluginRoot}; PLUGIN_DATA=${pluginData}; PROBE_MODE=live`;
    completed[2]!.value = result;
    expect(resolveAgentPluginBundleResponse(request(completed))).toEqual({
      text: "AGENT_BUNDLE_MCP_OK",
    });
  });

  it.each<[string, (value: Round[]) => void]>([
    [
      "wrong search call",
      (value) => {
        value[0]!.name = "read";
      },
    ],
    [
      "wrong search query",
      (value) => {
        value[0]!.args.query = "other";
      },
    ],
    [
      "missing candidate",
      (value) => {
        value[0]!.value = [];
      },
    ],
    [
      "ambiguous candidates",
      (value) => {
        value[0]!.value = [target, { ...target, id: "other" }];
      },
    ],
    [
      "extraneous candidate",
      (value) => {
        value[0]!.value = [target, { ...target, id: "other", name: "other" }];
      },
    ],
    [
      "malformed extra candidate",
      (value) => {
        value[0]!.value = [target, null];
      },
    ],
    [
      "wrong candidate source",
      (value) => {
        value[0]!.value = [{ ...target, source: "openclaw" }];
      },
    ],
    [
      "wrong describe selector",
      (value) => {
        value[1]!.args.id = "other";
      },
    ],
    [
      "wrong described target",
      (value) => {
        value[1]!.value = {
          ...target,
          id: "other",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        };
      },
    ],
    [
      "missing described schema",
      (value) => {
        value[1]!.value = target;
      },
    ],
    [
      "wrong call selector",
      (value) => {
        value[2]!.args.id = "other";
      },
    ],
    [
      "unexpected target arguments",
      (value) => {
        value[2]!.args.args = { unexpected: true };
      },
    ],
    [
      "wrong receipt target",
      (value) => {
        value[2]!.value = { ...targetResult(), tool: { ...target, id: "other" } };
      },
    ],
    [
      "missing target details",
      (value) => {
        value[2]!.value = {
          tool: target,
          result: { content: [{ type: "text", text: probeText }] },
        };
      },
    ],
    [
      "wrong MCP server",
      (value) => {
        const result = targetResult();
        result.result.details.mcpServer = "other";
        value[2]!.value = result;
      },
    ],
    [
      "wrong MCP operation",
      (value) => {
        const result = targetResult();
        result.result.details.mcpTool = "other";
        value[2]!.value = result;
      },
    ],
    [
      "failed target result",
      (value) => {
        const result = targetResult();
        value[2]!.value = {
          ...result,
          result: { ...result.result, details: { ...result.result.details, status: "error" } },
        };
      },
    ],
    [
      "missing environment evidence",
      (value) => {
        const result = targetResult();
        result.result.content[0]!.text = "probe ok";
        value[2]!.value = result;
      },
    ],
    [
      "corrupted probe success field",
      (value) => {
        const result = targetResult();
        result.result.content[0]!.text = probeText.replace("probe ok", "probe ok=false");
        value[2]!.value = result;
      },
    ],
    [
      "corrupted probe mode field",
      (value) => {
        const result = targetResult();
        result.result.content[0]!.text = probeText.replace(
          "PROBE_MODE=live",
          "PROBE_MODE=live-corrupt",
        );
        value[2]!.value = result;
      },
    ],
    [
      "LF-suffixed probe mode field",
      (value) => {
        const result = targetResult();
        result.result.content[0]!.text = `${probeText}\n`;
        value[2]!.value = result;
      },
    ],
    [
      "CRLF-suffixed probe mode field",
      (value) => {
        const result = targetResult();
        result.result.content[0]!.text = `${probeText}\r\n`;
        value[2]!.value = result;
      },
    ],
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
      "unstructured success text",
      (body) => {
        body.input[6]!.output = probeText;
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
