import { VERSION } from "../../version.js";
import { resolveCliChannelOptions } from "../channel-options.js";

export type ProgramContext = {
  /** Version string shown in CLI help and version output. */
  programVersion: string;
  /** Lazily resolved channel choices for commands that need a list. */
  channelOptions: string[];
  /** Pipe-delimited channel choices for message command help text. */
  messageChannelOptions: string;
  /** Pipe-delimited agent channel choices, including the `last` pseudo-channel. */
  agentChannelOptions: string;
};

/** Create lazily computed context shared by command registration helpers. */
export function createProgramContext(): ProgramContext {
  let cachedChannelOptions: string[] | undefined;
  const getChannelOptions = (): string[] => {
    if (cachedChannelOptions === undefined) {
      cachedChannelOptions = resolveCliChannelOptions();
    }
    return cachedChannelOptions;
  };

  return {
    programVersion: VERSION,
    get channelOptions() {
      return getChannelOptions();
    },
    get messageChannelOptions() {
      return getChannelOptions().join("|");
    },
    get agentChannelOptions() {
      return ["last", ...getChannelOptions()].join("|");
    },
  };
}
