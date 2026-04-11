import type { SignalSender } from "@openclaw/signal/contract-api.js";
import { loadBundledPluginContractApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type SignalContractApiSurface = Pick<
  typeof import("@openclaw/signal/contract-api.js"),
  "isSignalSenderAllowed"
>;

const { isSignalSenderAllowed } =
  loadBundledPluginContractApiSync<SignalContractApiSurface>("signal");

export { isSignalSenderAllowed };
export type { SignalSender };
