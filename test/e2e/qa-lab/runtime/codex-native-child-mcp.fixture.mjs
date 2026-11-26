// Harmless stdio MCP server. Keep the nonce out of prompts and catalog descriptions.
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const dir = process.argv[2];
const names = ["get_nonce", "get_denied"];
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { method, params, id } = JSON.parse(line);
  if (id === undefined) {
    continue;
  }
  let result;
  if (method === "initialize") {
    result = {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "native-child-stdio", version: "1.0.0" },
    };
  } else if (method === "tools/list") {
    result = {
      tools: names.map((name) => ({
        name,
        description: "Return a harmless local test receipt.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      })),
    };
  } else if (method === "tools/call") {
    const name = names.includes(params.name) ? params.name : "unexpected";
    await fs.appendFile(path.join(dir, "calls"), name + "\n");
    result = {
      content: [
        {
          type: "text",
          text:
            name === "get_nonce"
              ? await fs.readFile(path.join(dir, "nonce"), "utf8")
              : "Not a nonce.",
        },
      ],
    };
  } else if (method === "ping") {
    result = {};
  }
  const reply = result ? { result } : { error: { code: -32601, message: "Method not found" } };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...reply }) + "\n");
}
