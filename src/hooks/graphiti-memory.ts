import { GraphService } from "../services/memory/GraphService.js";

/**
 * GraphitiMemoryHook intercepts messages to persist them into the neural graph.
 */
export default {
  metadata: {
    hookKey: "graphiti-memory",
    events: ["message:new", "reply:new"],
    requires: {
      env: ["GRAPHITI_MCP_URL"],
    },
  },

  async onEvent(
    event: string,
    payload: {
      message?: { text?: string };
      reply?: { text?: string };
    },
  ) {
    const graphURL = process.env.GRAPHITI_MCP_URL || "http://localhost:8001";
    const graph = new GraphService(graphURL);
    // Use a stable global ID for the user's memory, ignoring the ephemeral sessionKey
    const sessionId = "global-user-memory";

    if (event === "message:new") {
      await graph.addEpisode(sessionId, `human: ${payload.message?.text || ""}`);
    } else if (event === "reply:new") {
      await graph.addEpisode(sessionId, `assistant: ${payload.reply?.text || ""}`);
    }
  },
};
