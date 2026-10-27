import type { ApplicationContext } from "../../app/context-types.ts";
import { createSharedSourceProjection } from "./shared-owner-projection.ts";

const projectContext = createSharedSourceProjection({
  read: (context: ApplicationContext) => context,
  subscribe: (context, notify) => {
    const stops = [context.agents, context.agentIdentity, context.gateway].map((source) =>
      source.subscribe(notify),
    );
    return () => stops.forEach((stop) => stop());
  },
});
const missingContext = { read: () => undefined, revision: () => 0 };

/** Agent rows share one observed revision for their application's three owners. */
export function projectAgentRowContext(context: ApplicationContext | undefined) {
  return context ? projectContext(context) : missingContext;
}
