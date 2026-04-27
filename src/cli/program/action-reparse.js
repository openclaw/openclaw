import { buildParseArgv } from "../argv.js";
import { resolveActionArgs } from "./helpers.js";
export async function reparseProgramFromActionArgs(program, actionArgs) {
    const actionCommand = actionArgs.at(-1);
    const root = actionCommand?.parent ?? program;
    const rawArgs = root.rawArgs;
    const actionArgsList = resolveActionArgs(actionCommand);
    const fallbackArgv = actionCommand?.name()
        ? [actionCommand.name(), ...actionArgsList]
        : actionArgsList;
    const parseArgv = buildParseArgv({
        programName: program.name(),
        rawArgs,
        fallbackArgv,
    });
    await program.parseAsync(parseArgv);
}
