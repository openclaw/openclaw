import type { AnyAgentTool } from "./agent-tools.types.js";

type InvocationMetadata = {
  executionMode?: AnyAgentTool["executionMode"];
  ownsTurnHandoff: boolean;
};
const handoffOwners = new WeakSet<object>();
const resolvers = new WeakMap<object, (args: unknown) => InvocationMetadata>();

/** Only native creator identities may preserve a deliberate run-owner handoff. */
export function markToolTurnHandoffOwner<T extends AnyAgentTool>(tool: T): T {
  handoffOwners.add(tool);
  return tool;
}
export function bindToolInvocationResolver(
  tool: AnyAgentTool,
  resolve: (args: unknown) => InvocationMetadata,
): AnyAgentTool {
  resolvers.set(tool, resolve);
  return tool;
}
export function getToolInvocationMetadata(
  tool: Pick<AnyAgentTool, "executionMode">,
  args: unknown,
): InvocationMetadata {
  const resolve = resolvers.get(tool);
  if (resolve) {
    try {
      return resolve(args);
    } catch {
      // Invalid/unknown targets retain their ordinary dispatch validation error.
      return { ownsTurnHandoff: false };
    }
  }
  return { executionMode: tool.executionMode, ownsTurnHandoff: handoffOwners.has(tool) };
}
export function copyToolInvocationMetadata(source: object, target: object): void {
  if (handoffOwners.has(source)) {
    handoffOwners.add(target);
  }
  const resolve = resolvers.get(source);
  if (resolve) {
    resolvers.set(target, resolve);
  }
}
