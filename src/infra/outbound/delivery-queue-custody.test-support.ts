import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

export function installCustodyMatrixPlugin(outbound: ChannelOutboundAdapter) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({ id: "matrix", outbound }),
      },
    ]),
  );
}

/** Fail promptly if the operation settles instead of reaching its held reply. */
export function awaitCustodyReply<T>(held: Promise<T>, outcome: Promise<unknown>) {
  return Promise.race([
    held,
    outcome.then((result) => {
      throw new Error("Operation settled before its committed queue reply", { cause: result });
    }),
  ]);
}
