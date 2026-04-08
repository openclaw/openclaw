import { loadBundledPluginTestApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type CreateIMessageTestPlugin =
  typeof import("../../../extensions/imessage/src/test-plugin.js").createIMessageTestPlugin;

let createIMessageTestPluginCache: CreateIMessageTestPlugin | undefined;

function getCreateIMessageTestPlugin(): CreateIMessageTestPlugin {
  if (!createIMessageTestPluginCache) {
    ({ createIMessageTestPlugin: createIMessageTestPluginCache } = loadBundledPluginTestApiSync<{
      createIMessageTestPlugin: CreateIMessageTestPlugin;
    }>("imessage"));
  }
  return createIMessageTestPluginCache;
}

export const createIMessageTestPlugin: CreateIMessageTestPlugin = (...args) =>
  getCreateIMessageTestPlugin()(...args);
