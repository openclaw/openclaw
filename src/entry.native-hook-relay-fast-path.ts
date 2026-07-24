import { getCommandPathWithRootOptions } from "./cli/argv.js";
import type {
  NativeHookRelayCliOptions,
  runNativeHookRelayCli as RunNativeHookRelayCli,
} from "./cli/native-hook-relay-cli.js";

type NativeHookRelayFastPathDeps = {
  runRelay?: typeof RunNativeHookRelayCli;
  setExitCode?: (exitCode: number) => void;
};

const RELAY_OPTION_KEYS: Record<string, keyof NativeHookRelayCliOptions> = {
  "--provider": "provider",
  "--relay-id": "relayId",
  "--state-db": "stateDb",
  "--generation": "generation",
  "--event": "event",
  "--pre-tool-use-unavailable": "preToolUseUnavailable",
  "--timeout": "timeout",
};

/** Handle the internal native relay before the full CLI/plugin graph is imported. */
export async function tryHandleNativeHookRelayFastPath(
  argv: string[],
  deps: NativeHookRelayFastPathDeps = {},
): Promise<boolean> {
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  if (primary !== "hooks" || secondary !== "relay") {
    return false;
  }

  const relayIndex = findRelayCommandIndex(argv);
  if (relayIndex === -1) {
    return false;
  }

  const options = parseRelayOptions(argv.slice(relayIndex + 1));
  if (!options) {
    return false;
  }

  const runRelay =
    deps.runRelay ?? (await import("./cli/native-hook-relay-cli.js")).runNativeHookRelayCli;
  const exitCode = await runRelay(options);
  if (deps.setExitCode) {
    deps.setExitCode(exitCode);
  } else {
    await exitAfterNativeHookRelayOutput(exitCode);
  }
  return true;
}

async function exitAfterNativeHookRelayOutput(exitCode: number): Promise<never> {
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          stream.write("", "utf8", () => resolve());
        }),
    ),
  );
  process.exit(exitCode);
}

function findRelayCommandIndex(argv: string[]): number {
  for (let index = 2; index < argv.length - 1; index += 1) {
    if (argv[index] === "hooks" && argv[index + 1] === "relay") {
      return index + 1;
    }
  }
  return -1;
}

function parseRelayOptions(args: string[]): NativeHookRelayCliOptions | null {
  const options: NativeHookRelayCliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      return null;
    }
    const equalsIndex = token.indexOf("=");
    const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
    const key = RELAY_OPTION_KEYS[flag];
    if (!key) {
      return null;
    }
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || (!inlineValue && value.startsWith("--"))) {
      return null;
    }
    Object.assign(options, { [key]: value });
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  return options;
}
