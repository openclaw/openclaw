import { VERSION } from "../../version.js";

export type ChannelOptionsProvider = () => string[];

export type ProgramContext = {
  programVersion: string;
  channelOptions: string[];
  messageChannelOptions: string;
  agentChannelOptions: string;
};

export function createProgramContext(getChannelOptions?: ChannelOptionsProvider): ProgramContext {
  let cached: string[] | null = null;
  const resolve = () => {
    if (!cached) {
      cached = getChannelOptions?.() ?? [];
    }
    return cached;
  };
  return {
    programVersion: VERSION,
    get channelOptions() {
      return resolve();
    },
    get messageChannelOptions() {
      return resolve().join("|");
    },
    get agentChannelOptions() {
      return ["last", ...resolve()].join("|");
    },
  };
}
