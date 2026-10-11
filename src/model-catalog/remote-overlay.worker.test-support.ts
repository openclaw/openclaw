import { parentPort } from "node:worker_threads";
import {
  getActiveRemoteModelCatalog,
  getRemoteModelCatalogProviderOverlay,
} from "./remote-overlay.js";

parentPort!.postMessage(
  {
    overlay: getRemoteModelCatalogProviderOverlay({}, "anthropic"),
    pricing: getActiveRemoteModelCatalog({})?.pricing,
  },
  [],
);
