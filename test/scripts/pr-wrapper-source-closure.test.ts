import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";

const components = [
  "scripts/pr",
  "scripts/pr-lib",
  ...readFileSync("scripts/pr-lib/wrapper-components.txt", "utf8").trim().split("\n"),
];

it.each([
  "src/infra/gateway-state-owner.ts",
  "src/plugins/discovery.ts",
  "src/infra/sqlite-readonly-location.worker.ts",
])(
  "retains %s and its relative ESM runtime dependencies in the wrapper inventory",
  (entrypoint) => {
    const closure = collectRuntimeImportClosure(process.cwd(), [entrypoint], {
      includeDynamicImports: true,
    });
    expect(
      closure.filter(
        (file) =>
          !components.some((component) => file === component || file.startsWith(`${component}/`)),
      ),
    ).toEqual([]);
  },
);
