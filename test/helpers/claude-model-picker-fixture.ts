export const CLAUDE_MODEL_DISCOVERY_ARGS = [
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-prompt-tool",
  "stdio",
  "--setting-sources",
  "user",
  "--settings",
  '{"disableAllHooks":true,"enabledPlugins":{}}',
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--tools",
  "",
];

export function buildClaudeModelPickerFixture(params: {
  nodePath: string;
  authCallsPath: string;
  inputsPath: string;
  modelIds: readonly string[];
}): string {
  return `#!${params.nodePath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(params.authCallsPath)}, JSON.stringify(argv) + "\\n");
if (JSON.stringify(argv) === JSON.stringify(["auth", "status", "--json"])) {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
} else if (JSON.stringify(argv) === ${JSON.stringify(JSON.stringify(CLAUDE_MODEL_DISCOVERY_ARGS))}) {
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    fs.appendFileSync(${JSON.stringify(params.inputsPath)}, line + "\\n");
    if (message.type !== "control_request" || typeof message.request_id !== "string" || !message.request_id || JSON.stringify(message.request) !== '{"subtype":"initialize","hooks":{}}') process.exit(1);
    process.stdout.write(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: { models: ${JSON.stringify(params.modelIds.map((resolvedModel) => ({ resolvedModel })))} },
    } }) + "\\n");
  });
} else process.exit(1);
`;
}
