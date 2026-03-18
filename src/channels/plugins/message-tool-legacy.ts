import type { ChannelMessageActionAdapter } from "./types.js";

export function createLegacyMessageToolDiscoveryMethods(
  describeMessageTool: NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>,
): Pick<ChannelMessageActionAdapter, "listActions" | "getCapabilities" | "getToolSchema"> {
  const describe = (ctx: Parameters<typeof describeMessageTool>[0]) =>
    describeMessageTool(ctx) ?? null;
  return {
    listActions: (ctx) => [...(describe(ctx)?.actions ?? [])],
    getCapabilities: (ctx) => [...(describe(ctx)?.capabilities ?? [])],
    getToolSchema: (ctx) => describe(ctx)?.schema ?? null,
  };
}
