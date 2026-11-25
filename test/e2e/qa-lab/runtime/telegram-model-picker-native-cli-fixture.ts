import fs from "node:fs/promises";
import path from "node:path";
import { createWindowsCmdShimFixture } from "openclaw/plugin-sdk/test-env";

export async function createNativeModelPickerCliFixture(fixtureRoot: string) {
  const cliPath = path.join(fixtureRoot, process.platform === "win32" ? "claude.cjs" : "claude");
  const authCallsPath = path.join(fixtureRoot, "native-auth-calls.jsonl");
  const nativeRequestsPath = path.join(fixtureRoot, "native-requests.jsonl");
  const authArgs = ["auth", "status", "--json"];
  const discoveryArgs = [
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
  if (process.platform === "win32") {
    await createWindowsCmdShimFixture({
      shimPath: path.join(fixtureRoot, "claude.cmd"),
      scriptPath: cliPath,
      shimLine: `@"${process.execPath}" "%~dp0\\claude.cjs" %*`,
    });
  }
  await fs.writeFile(
    cliPath,
    `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(authCallsPath)}, JSON.stringify(argv) + "\\n");
if (JSON.stringify(argv) === ${JSON.stringify(JSON.stringify(authArgs))}) {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
} else if (JSON.stringify(argv) === ${JSON.stringify(JSON.stringify(discoveryArgs))}) {
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    fs.appendFileSync(${JSON.stringify(nativeRequestsPath)}, JSON.stringify(message) + "\\n");
    if (message.type !== "control_request" || message.request.subtype !== "initialize") {
      process.exit(7);
    }
    process.stdout.write(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: { models: [
        { value: "haiku", resolvedModel: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
        { value: "sonnet", resolvedModel: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
      ] },
    } }) + "\\n");
  });
} else {
  process.exit(1);
}
`,
    { mode: 0o755 },
  );
  return { authCallsPath, nativeRequestsPath, authArgs, discoveryArgs };
}
