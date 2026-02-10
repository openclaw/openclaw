import { VERSION } from "../../version.js";

export type ProgramContext = {
  programVersion: string;
  channelOptions: string[];
  messageChannelOptions: string;
  agentChannelOptions: string;
};

// Core channel order inlined to avoid loading channels/registry.ts (which pulls
// in plugins/runtime.js). Plugin channel options are resolved at runtime when
// commands actually execute, not at registration time.
const CORE_CHANNEL_ORDER = [
  "telegram",
  "whatsapp",
  "discord",
  "googlechat",
  "slack",
  "signal",
  "imessage",
];

export function createProgramContext(): ProgramContext {
  return {
    programVersion: VERSION,
    channelOptions: CORE_CHANNEL_ORDER,
    messageChannelOptions: CORE_CHANNEL_ORDER.join("|"),
    agentChannelOptions: ["last", ...CORE_CHANNEL_ORDER].join("|"),
  };
}
