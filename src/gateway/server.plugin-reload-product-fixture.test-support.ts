import fs from "node:fs/promises";
import path from "node:path";

// Shared external-plugin fixture for the reload continuation product entries.
export const PLUGIN = "send-continuation-proof";
export const TOOL = "send_continuation_probe";

export type InputItem = {
  type?: string;
  role?: string;
  name?: string;
  call_id?: string;
  output?: string;
};
export function output(
  body: { input?: InputItem[] },
  name: string,
): Record<string, unknown> | undefined {
  const call = body.input?.findLast((item) => item.type === "function_call" && item.name === name);
  const value = body.input?.find(
    (item) => item.type === "function_call_output" && item.call_id === call?.call_id,
  )?.output;
  return value ? (JSON.parse(value) as Record<string, unknown>) : undefined;
}

// External loader fixture: observable tool/hooks only; no task or reload implementation.
export async function writePlugin(
  root: string,
  hooks: string,
  generationFile: string,
  failReload = false,
) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: PLUGIN, version: "1.0.0", openclaw: { extensions: ["./index.cjs"] } }),
  );
  await fs.writeFile(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN,
      contracts: { tools: [TOOL] },
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  await fs.writeFile(
    path.join(root, "index.cjs"),
    [
      'const fs = require("node:fs");',
      "module.exports = { id: " + JSON.stringify(PLUGIN) + ", register(api) {",
      "const file = " + JSON.stringify(generationFile) + ";",
      'const generation = fs.existsSync(file) ? Number(fs.readFileSync(file,"utf8")) + 1 : 1;',
      "fs.writeFileSync(file, String(generation));",
      ...(failReload
        ? ['if (generation > 1) throw new Error("fixture replacement unavailable");']
        : []),
      'for (const event of ["agent_end","llm_output"]) api.on(event, (data, ctx) => { fs.appendFileSync(' +
        JSON.stringify(hooks) +
        ', JSON.stringify({ event, generation, runId: ctx.runId ?? data.runId }) + "\\n"); });',
      "api.registerTool({ name: " +
        JSON.stringify(TOOL) +
        ', label: "Probe", description: "Observe the plugin generation", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: JSON.stringify({ plugin: ' +
        JSON.stringify(PLUGIN) +
        ", generation }) }] }; } });",
      "} };",
    ].join("\n"),
  );
}
