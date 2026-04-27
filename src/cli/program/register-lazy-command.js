import { reparseProgramFromActionArgs } from "./action-reparse.js";
import { removeCommandByName } from "./command-tree.js";
export function registerLazyCommand({ program, name, description, removeNames, register, }) {
    const placeholder = program.command(name).description(description);
    placeholder.allowUnknownOption(true);
    placeholder.allowExcessArguments(true);
    placeholder.action(async (...actionArgs) => {
        for (const commandName of new Set(removeNames ?? [name])) {
            removeCommandByName(program, commandName);
        }
        await register();
        await reparseProgramFromActionArgs(program, actionArgs);
    });
}
