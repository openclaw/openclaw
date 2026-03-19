/**
 * /remember [query] — search the Graphiti knowledge graph and return matching memories.
 */

import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import type { CommandHandler } from "./commands-types.js";

interface GraphMemory {
  content?: string;
  fact?: string;
  timestamp?: string | number | Date;
}

export const handleRememberCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const body = params.command.commandBodyNormalized;
  if (!/^\/remember\b/i.test(body)) {
    return null;
  }

  const query = body.replace(/^\/remember\b/i, "").trim();
  if (!query) {
    return {
      shouldContinue: false,
      reply: { text: "Uso: /remember <consulta>\nEjemplo: /remember Julio trabajo" },
    };
  }

  try {
    const [nodesResult, factsResult] = await Promise.allSettled([
      callGateway<{ nodes: GraphMemory[] }>({
        method: "narrative.searchNodes",
        params: { query },
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientDisplayName: "remember command",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      }),
      callGateway<{ facts: GraphMemory[] }>({
        method: "narrative.searchFacts",
        params: { query },
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientDisplayName: "remember command",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      }),
    ]);

    const nodes = nodesResult.status === "fulfilled" ? (nodesResult.value?.nodes ?? []) : [];
    const facts = factsResult.status === "fulfilled" ? (factsResult.value?.facts ?? []) : [];

    const combined: GraphMemory[] = [...nodes, ...facts];

    if (combined.length === 0) {
      return {
        shouldContinue: false,
        reply: { text: `💤 No encontré memorias para: _${query}_` },
      };
    }

    const lines = combined.slice(0, 20).map((item) => {
      const content =
        (typeof item.content === "string" ? item.content : null) ||
        (typeof item.fact === "string" ? item.fact : null) ||
        "";
      const date = item.timestamp
        ? `[${new Date(item.timestamp).toISOString().split("T")[0]}] `
        : "";
      return `• ${date}${content}`;
    });

    return {
      shouldContinue: false,
      reply: {
        text: `🧠 *${combined.length} memorias* para _${query}_:\n\n${lines.join("\n")}`,
      },
    };
  } catch (e: unknown) {
    return {
      shouldContinue: false,
      reply: { text: `❌ Error buscando memorias: ${String(e)}` },
    };
  }
};
