import { afterEach, vi } from "vitest";
import type { PrecomputedCommandHelpName } from "./precomputed-help-commands.js";
import type { RootHelpRenderOptions } from "./program/root-help.js";

const mocks = vi.hoisted(() => ({
  outputPrecomputedCommandHelpText: vi.fn(),
  loadRootHelpRenderOptionsForConfigSensitivePlugins: vi.fn(),
}));

vi.mock("./root-help-metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./root-help-metadata.js")>()),
  outputPrecomputedRootHelpText: () => false,
  outputPrecomputedCommandHelpText: mocks.outputPrecomputedCommandHelpText,
}));
vi.mock("./root-help-live-config.js", () => ({
  loadRootHelpRenderOptionsForConfigSensitivePlugins:
    mocks.loadRootHelpRenderOptionsForConfigSensitivePlugins,
}));
afterEach(() => vi.unstubAllEnvs());

export function runWithPrecomputedHelpMocks(
  run: (argv: string[]) => Promise<boolean>,
  argv: string[],
  setup: {
    env?: NodeJS.ProcessEnv;
    outputPrecomputedCommandHelpText?: (name: PrecomputedCommandHelpName) => boolean;
    loadRootHelpRenderOptionsForConfigSensitivePlugins?: (
      env?: NodeJS.ProcessEnv,
    ) => Promise<RootHelpRenderOptions | null>;
  },
) {
  if (setup.env) {
    for (const name of ["OPENCLAW_CONTAINER", "OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH"]) {
      vi.stubEnv(name, setup.env[name]);
    }
  }
  for (const name of [
    "outputPrecomputedCommandHelpText",
    "loadRootHelpRenderOptionsForConfigSensitivePlugins",
  ] as const) {
    mocks[name].mockReset();
    const implementation = setup[name];
    if (implementation) {
      mocks[name].mockImplementation(implementation);
    }
  }
  return run(argv);
}
