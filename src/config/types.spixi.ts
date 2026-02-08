import type { DmPolicy, GroupPolicy } from "./types.base.js";

export interface SpixiAccountConfig {
  enabled?: boolean;
  name?: string;
  quixiApiUrl?: string;
  mqttHost?: string;
  mqttPort?: number;
  myWalletAddress?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
  groupPolicy?: GroupPolicy;
}

export interface SpixiConfig extends SpixiAccountConfig {
  accounts?: Record<string, SpixiAccountConfig>;
}
