import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { standaloneRuntimeProcessBuildEntries } from "../../scripts/lib/runtime-process-core-build-entries.mts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const forbiddenInputs = [
  /^src\/gateway\/server(\.|-|\/)/u,
  /^src\/flows\//u,
  /^src\/wizard\//u,
  /^src\/agents\/tools\/in-process-gateway\.ts$/u,
  /^src\/infra\/update-run-write\.ts$/u,
  /^src\/infra\/update-failure-facts\.ts$/u,
];

describe("standalone runtime process build graph", () => {
  it.each(Object.entries(standaloneRuntimeProcessBuildEntries))(
    "keeps %s out of the Gateway server graph",
    async (_name, entry) => {
      const result = await build({
        absWorkingDir: repoRoot,
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        packages: "external",
        write: false,
        metafile: true,
      });
      const inputs = Object.keys(result.metafile.inputs).map((input) =>
        input.replaceAll("\\", "/"),
      );
      expect(
        inputs.filter((input) => forbiddenInputs.some((pattern) => pattern.test(input))),
      ).toEqual([]);
    },
  );
});
