import {
  getCommandPositionalsWithRootOptions,
  getRootOptionAwareCommandPath,
  getUpdateCommandPath,
} from "../infra/cli-root-options.js";

const AGENT_PARENT_BOOLEAN_FLAGS = ["--local", "--deliver", "--json"];
const AGENT_PARENT_VALUE_FLAGS = [
  "-m",
  "--message",
  "--message-file",
  "-t",
  "--to",
  "--session-key",
  "--session-id",
  "--agent",
  "--model",
  "--thinking",
  "--verbose",
  "--channel",
  "--reply-to",
  "--reply-channel",
  "--reply-account",
  "--timeout",
];
export const MODELS_PARENT_BOOLEAN_FLAGS = ["--json", "--status-json", "--status-plain"];
export const MODELS_PARENT_VALUE_FLAGS = ["--agent"];

type ParentCommandFlags = readonly [booleanFlags: readonly string[], valueFlags: readonly string[]];

const PARENT_COMMAND_FLAGS: ReadonlyMap<string, ParentCommandFlags> = new Map([
  ["agent", [AGENT_PARENT_BOOLEAN_FLAGS, AGENT_PARENT_VALUE_FLAGS]],
  ["models", [MODELS_PARENT_BOOLEAN_FLAGS, MODELS_PARENT_VALUE_FLAGS]],
  ["config", [[], ["--section"]]],
  ["skills", [["--json"], ["--agent"]]],
  ["channels", [[], ["--agent"]]],
]);

/** Resolve the parent commands whose options may precede a child command. */
export function resolveCliParentCommandPath(
  argv: readonly string[],
  expectedParent?: "models" | "config" | "skills",
): string[] | null {
  const [command] = getRootOptionAwareCommandPath(argv, 1);
  if (!command || (expectedParent && command !== expectedParent)) {
    return null;
  }
  if (command === "update") {
    return getUpdateCommandPath(argv);
  }
  const flags = PARENT_COMMAND_FLAGS.get(command);
  if (!flags) {
    return null;
  }
  const [booleanFlags, valueFlags] = flags;
  const child = getCommandPositionalsWithRootOptions(argv, {
    commandPath: [command],
    booleanFlags,
    valueFlags,
    maxPositionals: 1,
    mode: "command-path",
  })?.[0];
  return child ? [command, child] : [command];
}
