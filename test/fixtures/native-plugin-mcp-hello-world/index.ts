import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "native-plugin-mcp-hello-world",
  name: "Native Plugin MCP Hello World",
  description: "Dummy development plugin that registers a hello-world MCP server",
  register(api) {
    api.registerMcpServer("helloWorld", {
      command: process.execPath,
      args: [fileURLToPath(new URL("./hello-world.mjs", import.meta.url))],
      env: {
        HELLO_WORLD_TEXT: "hi human",
      },
    });
  },
});
