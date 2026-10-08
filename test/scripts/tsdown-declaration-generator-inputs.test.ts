import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { resolveTsdownDeclarationGeneratorInputs } from "../../scripts/lib/tsdown-declaration-generator-inputs.mts";
import { createDeclarationFixture, createDeclarationTest } from "./tsdown-declaration-fixture.js";

const it = createDeclarationTest();

it("captures the optional native bootstrap without admitting value or unknown dynamic edges", ({
  command,
}) =>
  command.lifetime.run(async () => {
    const { root, write } = createDeclarationFixture(command);
    const entry = "scripts/write-plugin-sdk-entry-dts.ts";
    const lockPath = "scripts/lib/dist-artifact-lock.mts";
    const source = fs.readFileSync(path.join(root, lockPath), "utf8");
    const inputs = resolveTsdownDeclarationGeneratorInputs(root, entry);
    expect(inputs).toContain(path.join(root, "scripts/lib/dist-artifact-native.mts"));
    expect(inputs.some((file) => file.endsWith("/vitest-worker-run.mts"))).toBe(false);
    expect(inputs.some((file) => file.includes("/service-child-relay"))).toBe(false);

    // The exact computed import stays accounted for; a second edge is not a
    // license to omit an executable dependency from declaration cache identity.
    write(lockPath, source + "\nexport function unknownEdge(value) { return import(value); }\n");
    expect(() => resolveTsdownDeclarationGeneratorInputs(root, entry)).toThrow(
      "Unresolved dynamic module edges in scripts/lib/dist-artifact-lock.mts",
    );
    write(
      lockPath,
      source.replace(
        "import type { runNativeArtifactOperation }",
        "import { runNativeArtifactOperation }",
      ),
    );
    expect(() => resolveTsdownDeclarationGeneratorInputs(root, entry)).toThrow(
      "Unresolved dynamic module edges in scripts/lib/dist-artifact-native.mts",
    );
    // A type import alongside a value import must not hide the latter.
    write(
      lockPath,
      source +
        '\nimport { runNativeArtifactOperation as value } from "./dist-artifact-native.mts";\n',
    );
    expect(() => resolveTsdownDeclarationGeneratorInputs(root, entry)).toThrow(
      "Unresolved dynamic module edges in scripts/lib/dist-artifact-native.mts",
    );
  }));
