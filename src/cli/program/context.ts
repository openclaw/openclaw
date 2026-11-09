import type { DoctorDatabasePreflight } from "../../commands/doctor-database-preflight.js";
import { VERSION } from "../../version.js";
import { resolveCliChannelOptions } from "../channel-options.js";

export type ProgramContext = {
  doctorDatabasePreflight?: DoctorDatabasePreflight;
  runtimeRecoveryEnv?: NodeJS.ProcessEnv;
  programVersion: string;
  messageChannelOptions: string;
  agentChannelOptions: string;
};

/** Create a program context that resolves channel options once on first use. */
export function createProgramContext(
  prepared: Pick<ProgramContext, "doctorDatabasePreflight" | "runtimeRecoveryEnv"> = {},
): ProgramContext {
  let cachedChannelOptions: string[] | undefined;
  const getChannelOptions = () => (cachedChannelOptions ??= resolveCliChannelOptions());

  return {
    ...prepared,
    programVersion: VERSION,
    get messageChannelOptions() {
      return getChannelOptions().join("|");
    },
    get agentChannelOptions() {
      return ["last", ...getChannelOptions()].join("|");
    },
  };
}
