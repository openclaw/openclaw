import { resolveHeartbeatResponseTool } from "./heartbeat-response-tool.js";

export function createHeartbeatResponseTool() {
  const tool = resolveHeartbeatResponseTool({ enableHeartbeatTool: true });
  if (!tool) {
    throw new Error("Heartbeat runs must offer the response tool");
  }
  return tool;
}
