import type { OpenClawConfig } from "./types.openclaw.js";

export const MOBILE_IOS_DEVICE_ONLY_CONFIG: Readonly<OpenClawConfig> = {
  gateway: {
    mode: "local",
    bind: "loopback",
    nodes: {
      platformAllowlist: ["ios", "ipados"],
    },
  },
};
