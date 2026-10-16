import path from "node:path";
import type { Plugin } from "esbuild";

/** Launcher fixtures consume command metadata, never the lazy command registrars. */
export function createLauncherCommandBoundaryPlugin(): Plugin {
  const catalog = path.resolve("src/cli/program/subcli-descriptors.ts");
  const namespace = "launcher-command-registration";
  return {
    name: namespace,
    setup(build) {
      build.onResolve({ filter: /^\./ }, (args) => {
        if (args.kind !== "dynamic-import" || args.importer !== catalog) {
          return undefined;
        }
        return { path: args.path, namespace };
      });
      build.onLoad({ filter: /./, namespace }, () => ({
        contents: 'throw new Error("Launcher fixture must not register CLI commands");',
        loader: "js",
      }));
    },
  };
}
