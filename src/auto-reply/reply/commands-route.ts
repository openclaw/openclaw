import { getRoutingInstance } from "../../gateway/routing/routing-instance.js";
import { resolveL1TaskType, resolveTaskType } from "../../gateway/routing/task-resolver.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

/**
 * /route <text>
 *
 * Debug command: shows how the routing engine classifies the given text,
 * including L1 keyword result and L1.5 semantic router result (when available).
 *
 * Example output:
 *   🔀 Routing: "帮我看看代码"
 *   Result: CODE_REVIEW (L1 keyword)
 *   L1.5: CODE_REVIEW (score: 0.82)
 */
export const handleRouteCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/route" && !normalized.startsWith("/route ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /route from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // Extract the text to classify (everything after "/route ")
  const text = normalized.startsWith("/route ") ? normalized.slice("/route ".length).trim() : "";

  if (!text) {
    return {
      shouldContinue: false,
      reply: {
        text: "Usage: /route <text to classify>\nExample: /route 帮我看看代码",
      },
    };
  }

  // L1: keyword rule matching (synchronous)
  const l1Result = resolveL1TaskType(text);

  // L1.5: semantic router — requires routing config and an initialized router
  const routingConfig = params.cfg.routing;
  const semanticRouter = routingConfig
    ? getRoutingInstance(routingConfig).semanticRouter
    : undefined;

  let l15Line: string;
  if (!semanticRouter) {
    l15Line = "L1.5: not available";
  } else if (!semanticRouter.isInitialized) {
    l15Line = "L1.5: initializing…";
  } else {
    const l15Result = await semanticRouter.resolve(text);
    if (l15Result !== null) {
      l15Line = `L1.5: ${l15Result}`;
    } else {
      l15Line = "L1.5: no match (below threshold)";
    }
  }

  // Overall result: use resolveTaskType for the authoritative answer
  const overall = await resolveTaskType(text, semanticRouter);
  const source =
    l1Result !== null ? "L1 keyword" : semanticRouter?.isInitialized ? "L1.5 semantic" : "fallback";

  const lines = [`🔀 Routing: "${text}"`, `Result: ${overall} (${source})`, l15Line];

  return {
    shouldContinue: false,
    reply: { text: lines.join("\n") },
  };
};
