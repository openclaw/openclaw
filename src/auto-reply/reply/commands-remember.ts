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

  // When no query given, pass the session file path so the gateway can read recent messages
  const sessionFile = params.sessionEntry?.sessionFile;

  try {
    const factsResult = await callGateway<{ facts: GraphMemory[]; query?: string }>({
      method: "narrative.searchFacts",
      params: query ? { query } : { sessionFile },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "remember command",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });

    const combined: GraphMemory[] = factsResult?.facts ?? [];
    // Use the query returned by the gateway (may be observer-generated when no query given)
    const displayQuery = factsResult?.query ?? query;

    if (combined.length === 0) {
      const label = displayQuery ? `_${displayQuery}_` : "el contexto actual";
      return {
        shouldContinue: false,
        reply: { text: `💤 No encontré memorias para: ${label}` },
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

    const label = displayQuery ? `_${displayQuery}_` : "el contexto actual";
    return {
      shouldContinue: false,
      reply: {
        text: `🧠 *${combined.length} memorias* para ${label}:\n\n${lines.join("\n")}`,
      },
    };
  } catch (e: unknown) {
    return {
      shouldContinue: false,
      reply: { text: `❌ Error buscando memorias: ${String(e)}` },
    };
  }
};
