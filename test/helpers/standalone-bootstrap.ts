import { createRequire } from "node:module";
import vm from "node:vm";

/** Node's script VM lacks import.meta; supply only the generated image loader intrinsic. */
export function runStandaloneBootstrap(
  source: string,
  context: vm.Context,
  requireImage: (specifier: string) => unknown = createRequire(import.meta.url),
): void {
  context.standaloneImageRequire = requireImage;
  vm.runInContext(source.replaceAll("import.meta.require", "standaloneImageRequire"), context);
}
