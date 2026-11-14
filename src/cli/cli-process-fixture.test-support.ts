import path from "node:path";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { localStateOwnerFixtureEntrypoint } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const entrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(localStateOwnerFixtureEntrypoint),
);

export function cliChildEnv(root: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    ...overrides,
  };
}

export function stateOwnerEnv(root: string, overrides: NodeJS.ProcessEnv = {}) {
  return cliChildEnv(root, {
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    ...overrides,
  });
}

export function runStateOwnerCli(env: NodeJS.ProcessEnv, args: string[], input?: string) {
  return runCliProcessChild({ nodeArgs: [...entrypoint, ...args], env, input });
}

// Keep Commander and exit finalization real; replace only the scenario's external producers.
export function cliOutputScript(options: {
  registration: [url: string, name: string];
  exitUrl: string;
  argv: string[];
  modules: Record<string, string>;
  setup?: string;
}) {
  return `
      import { registerHooks } from "node:module";
      import { Command } from "commander";
      const modules = ${JSON.stringify(options.modules)};
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const suffix = Object.keys(modules).find(key => specifier.endsWith(key));
          return suffix === undefined ? nextResolve(specifier, context) : {
            shortCircuit: true,
            url: "data:text/javascript," + encodeURIComponent(modules[suffix]),
          };
        },
      });
      const registration = await import(${JSON.stringify(options.registration[0])});
      const { runCliWithExitFinalization } = await import(${JSON.stringify(options.exitUrl)});
      process.argv = [process.execPath, "openclaw", ...${JSON.stringify(options.argv)}];
      await runCliWithExitFinalization({
        run: async () => {
          const program = new Command().name("openclaw");
          registration[${JSON.stringify(options.registration[1])}](program);
          ${options.setup ?? ""}
          await program.parseAsync(process.argv);
        },
        onError: error => { throw error; },
      });
    `;
}
