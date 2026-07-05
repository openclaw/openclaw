// Cached startup metadata readers for precomputed root and subcommand help text.
import { readCliStartupMetadata } from "./startup-metadata.js";

<<<<<<< HEAD
export type PrecomputedSubcommandHelpName =
  | "doctor"
  | "gateway"
  | "models"
  | "plugins"
  | "sessions"
  | "tasks";
=======
export type PrecomputedSubcommandHelpName = "doctor" | "gateway" | "models" | "plugins";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

let precomputedRootHelpText: string | null | undefined;
let precomputedBrowserHelpText: string | null | undefined;
let precomputedSecretsHelpText: string | null | undefined;
let precomputedNodesHelpText: string | null | undefined;
let precomputedSubcommandHelpText:
  | Partial<Record<PrecomputedSubcommandHelpName, string | null>>
  | undefined;

type PrecomputedHelpTextKey =
  | "rootHelpText"
  | "browserHelpText"
  | "secretsHelpText"
  | "nodesHelpText";

function loadPrecomputedHelpText(
  key: PrecomputedHelpTextKey,
  cache: string | null | undefined,
  setCache: (value: string | null) => void,
): string | null {
  // Missing metadata is expected in source checkouts; fall back to live Commander help.
  if (cache !== undefined) {
    return cache;
  }
  try {
    const parsed = readCliStartupMetadata(import.meta.url);
    if (parsed) {
      const value = parsed[key];
      if (typeof value === "string" && value.length > 0) {
        setCache(value);
        return value;
      }
    }
  } catch {
    // Fall back to live help rendering.
  }
  setCache(null);
  return null;
}

<<<<<<< HEAD
function loadPrecomputedSubcommandHelpText(commandName: string): string | null {
=======
export function loadPrecomputedRootHelpText(): string | null {
  return loadPrecomputedHelpText("rootHelpText", precomputedRootHelpText, (value) => {
    precomputedRootHelpText = value;
  });
}

export function loadPrecomputedBrowserHelpText(): string | null {
  return loadPrecomputedHelpText("browserHelpText", precomputedBrowserHelpText, (value) => {
    precomputedBrowserHelpText = value;
  });
}

export function loadPrecomputedSecretsHelpText(): string | null {
  return loadPrecomputedHelpText("secretsHelpText", precomputedSecretsHelpText, (value) => {
    precomputedSecretsHelpText = value;
  });
}

export function loadPrecomputedNodesHelpText(): string | null {
  return loadPrecomputedHelpText("nodesHelpText", precomputedNodesHelpText, (value) => {
    precomputedNodesHelpText = value;
  });
}

export function loadPrecomputedSubcommandHelpText(commandName: string): string | null {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (!isPrecomputedSubcommandHelpName(commandName)) {
    return null;
  }
  const cache = precomputedSubcommandHelpText?.[commandName];
  if (cache !== undefined) {
    return cache;
  }
  try {
    const parsed = readCliStartupMetadata(import.meta.url);
    const subcommandHelpText = parsed?.subcommandHelpText;
    if (isSubcommandHelpTextRecord(subcommandHelpText)) {
      const value = subcommandHelpText[commandName];
      if (typeof value === "string" && value.length > 0) {
        setPrecomputedSubcommandHelpText(commandName, value);
        return value;
      }
    }
  } catch {
    // Fall back to live help rendering.
  }
  setPrecomputedSubcommandHelpText(commandName, null);
  return null;
}

export function outputPrecomputedRootHelpText(): boolean {
<<<<<<< HEAD
  const rootHelpText = loadPrecomputedHelpText("rootHelpText", precomputedRootHelpText, (value) => {
    precomputedRootHelpText = value;
  });
=======
  const rootHelpText = loadPrecomputedRootHelpText();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (!rootHelpText) {
    return false;
  }
  process.stdout.write(rootHelpText);
  return true;
}

export function outputPrecomputedBrowserHelpText(): boolean {
<<<<<<< HEAD
  const browserHelpText = loadPrecomputedHelpText(
    "browserHelpText",
    precomputedBrowserHelpText,
    (value) => {
      precomputedBrowserHelpText = value;
    },
  );
=======
  const browserHelpText = loadPrecomputedBrowserHelpText();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (!browserHelpText) {
    return false;
  }
  process.stdout.write(browserHelpText);
  return true;
}

export function outputPrecomputedSecretsHelpText(): boolean {
<<<<<<< HEAD
  const secretsHelpText = loadPrecomputedHelpText(
    "secretsHelpText",
    precomputedSecretsHelpText,
    (value) => {
      precomputedSecretsHelpText = value;
    },
  );
=======
  const secretsHelpText = loadPrecomputedSecretsHelpText();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (!secretsHelpText) {
    return false;
  }
  process.stdout.write(secretsHelpText);
  return true;
}

export function outputPrecomputedNodesHelpText(): boolean {
<<<<<<< HEAD
  const nodesHelpText = loadPrecomputedHelpText(
    "nodesHelpText",
    precomputedNodesHelpText,
    (value) => {
      precomputedNodesHelpText = value;
    },
  );
=======
  const nodesHelpText = loadPrecomputedNodesHelpText();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (!nodesHelpText) {
    return false;
  }
  process.stdout.write(nodesHelpText);
  return true;
}

export function outputPrecomputedSubcommandHelpText(commandName: string): boolean {
  const helpText = loadPrecomputedSubcommandHelpText(commandName);
  if (!helpText) {
    return false;
  }
  process.stdout.write(helpText);
  return true;
}

function isPrecomputedSubcommandHelpName(
  commandName: string,
): commandName is PrecomputedSubcommandHelpName {
  return (
    commandName === "doctor" ||
    commandName === "gateway" ||
    commandName === "models" ||
<<<<<<< HEAD
    commandName === "plugins" ||
    commandName === "sessions" ||
    commandName === "tasks"
=======
    commandName === "plugins"
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  );
}

function isSubcommandHelpTextRecord(
  value: unknown,
): value is Partial<Record<PrecomputedSubcommandHelpName, unknown>> {
  return typeof value === "object" && value !== null;
}

function setPrecomputedSubcommandHelpText(
  commandName: PrecomputedSubcommandHelpName,
  value: string | null,
): void {
  precomputedSubcommandHelpText = {
    ...precomputedSubcommandHelpText,
    [commandName]: value,
  };
}
<<<<<<< HEAD
=======

export const testing = {
  resetPrecomputedRootHelpTextForTests(): void {
    precomputedRootHelpText = undefined;
    precomputedBrowserHelpText = undefined;
    precomputedSecretsHelpText = undefined;
    precomputedNodesHelpText = undefined;
    precomputedSubcommandHelpText = undefined;
  },
};
export { testing as __testing };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
