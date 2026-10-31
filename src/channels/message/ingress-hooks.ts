import type { PluginHookBeforeChannelIngressContext } from "../../plugins/hook-message.types.js";

/** Await enabled ingress policies without materializing a plugin runtime at channel startup. */
export async function prepareChannelIngressEvent(
  event: unknown,
  context: PluginHookBeforeChannelIngressContext,
): Promise<{ event: unknown; assertCurrent: () => void } | undefined> {
  const { getGlobalHookRunner } = await import("../../plugins/hook-runner-global.js");
  return await getGlobalHookRunner()?.runBeforeChannelIngress({ event }, context);
}
