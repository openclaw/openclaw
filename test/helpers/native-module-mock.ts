import { createRequire } from "node:module";
import { mock } from "node:test";

const require = createRequire(import.meta.url);

/** Install fixture exports for the lifetime of an isolated native child or worker. */
export function mockNativeModuleExports(
  specifier: string | URL,
  namedExports: Record<string, unknown>,
): void {
  if (process.versions.bun) {
    const { mock: bunMock } = require("bun:test") as {
      mock: { module: (id: string, factory: () => Record<string, unknown>) => void };
    };
    bunMock.module(String(specifier), () => namedExports);
  } else {
    mock.module(specifier, { namedExports });
  }
}
