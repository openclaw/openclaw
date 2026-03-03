import path from "node:path";
export const DEFAULT_CLI_NAME = "openclaw";
const KNOWN_CLI_NAMES = new Set([DEFAULT_CLI_NAME]);
const CLI_PREFIX_RE = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(openclaw)\b/;
export function resolveCliName(argv = process.argv) {
    const argv1 = argv[1];
    if (!argv1) {
        return DEFAULT_CLI_NAME;
    }
    const base = path.basename(argv1).trim();
    if (KNOWN_CLI_NAMES.has(base)) {
        return base;
    }
    return DEFAULT_CLI_NAME;
}
export function replaceCliName(command, cliName = resolveCliName()) {
    if (!command.trim()) {
        return command;
    }
    if (!CLI_PREFIX_RE.test(command)) {
        return command;
    }
    return command.replace(CLI_PREFIX_RE, (_match, runner) => {
        return `${runner ?? ""}${cliName}`;
    });
}
