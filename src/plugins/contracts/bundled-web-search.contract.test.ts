import { describeBundledWebSearchFastPathContract } from "../../../test/helpers/plugins/bundled-web-search-fast-path-contract.js";
import { listBundledWebSearchProviders } from "../bundled-web-search.js";

const pluginIds = [
  ...new Set(listBundledWebSearchProviders().map((entry) => entry.pluginId)),
].toSorted();

for (const pluginId of pluginIds) {
  describeBundledWebSearchFastPathContract(pluginId);
}
