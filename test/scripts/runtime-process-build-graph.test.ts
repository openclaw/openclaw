import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  sharedRuntimeProcessBuildEntries,
  standaloneRuntimeProcessBuildEntries,
} from "../../scripts/lib/runtime-process-core-build-entries.mts";

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
  it("isolates the metadata inventory program from the shared runtime graph", () => {
    expect(
      sharedRuntimeProcessBuildEntries({
        "infra/update-state-sizes.entry": "src/infra/update-state-sizes.entry.ts",
        "fixture/shared": "fixture/shared.ts",
      }),
    ).toEqual({ "fixture/shared": "fixture/shared.ts" });
  });

  it("keeps small disk, attachment, and catalog workers out of shared Gateway chunks", () => {
    const workers = [
      "config/sessions/disk-budget.worker",
      "media/attachment-processor.worker",
      "agents/plugin-model-catalog-read.worker",
    ];
    expect(
      Object.keys(
        sharedRuntimeProcessBuildEntries(Object.fromEntries(workers.map((name) => [name, name]))),
      ),
    ).toHaveLength(0);
  });

  it.each(Object.entries(standaloneRuntimeProcessBuildEntries))(
    "keeps %s out of the Gateway server graph",
    async (name, entry) => {
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
      if (name === "infra/sqlite-source-revision.worker") {
        expect(
          inputs.filter((input) =>
            /^src\/(?:config\/|plugins\/|snapshot\/|infra\/(?:node-sqlite|update-database-generations)\.)/u.test(
              input,
            ),
          ),
        ).toEqual([]);
      }
    },
  );
});
