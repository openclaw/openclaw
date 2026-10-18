import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Compiler and process fixtures own no Gateway; its custody has separate boundary tests.
export function registerSourceRunnerServiceFixture(sourceRoot) {
  const rootUrl = pathToFileURL(sourceRoot + path.sep).href;
  const modules = new Map([
    [
      "src/cli/update-cli/update-command-service-publication.ts",
      "export async function withGatewayRuntimeArtifactPublication(_params, publish) { return publish(async () => {}); }",
    ],
    [
      "src/cli/profile.ts",
      "export function parseCliProfileArgs(argv) { return { ok: true, profile: null, argv }; } export function applyCliProfileEnv() { throw new Error('This fixture has no profile'); }",
    ],
    [
      "scripts/lib/live-gateway-dist-fence.mts",
      "export async function resolveLiveManagedGatewayDistFence() { return { refuse: false }; }",
    ],
  ]);
  registerHooks({
    load(url, context, nextLoad) {
      // The real wrappers load both source and prepared legacy-finalizer modules.
      const source = url.startsWith(rootUrl)
        ? [...modules].find(
            ([name]) =>
              url.endsWith(`/${name}`) || url.endsWith(`/${name.replace(/\.[cm]?ts$/u, ".js")}`),
          )?.[1]
        : undefined;
      return source === undefined
        ? nextLoad(url, context)
        : { format: "module", source, shortCircuit: true };
    },
  });
}
