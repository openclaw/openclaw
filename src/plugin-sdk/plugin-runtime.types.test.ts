import path from "node:path";
import { expect, it } from "vitest";
import { createNativeTypeScriptProject } from "../../scripts/lib/native-typescript.mts";

it("preserves strict reconciler typing and host-owned process configuration", () => {
  const cwd = path.resolve(import.meta.dirname, "../..");
  const configFileName = "tsconfig.plugin-runtime-types.json";
  const sourceFileName = path.join(cwd, "src/plugin-sdk/plugin-runtime.consumer.ts");
  const session = createNativeTypeScriptProject({
    cwd,
    configFileName,
    files: {
      [configFileName]: JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: { strict: true, exactOptionalPropertyTypes: true },
        files: [sourceFileName],
        include: [],
      }),
      [sourceFileName]: `import type { PluginRuntime } from "./plugin-runtime.js";
declare const runtime: PluginRuntime;
runtime.llm.acquireLocalService({
  providerId: "fixture",
  baseUrl: "http://localhost",
  reconcile: undefined,
}, null);
runtime.llm.acquireLocalService({
  providerId: "fixture",
  baseUrl: "http://localhost",
  reconcile: "invalid",
}, null);
runtime.llm.acquireLocalService({
  providerId: "fixture",
  baseUrl: "http://localhost",
  service: { command: "fixture" },
}, null);
`,
    },
  });
  try {
    expect(session.project.program.getSemanticDiagnostics(sourceFileName)).toEqual([
      expect.objectContaining({
        code: 2322,
        text: expect.stringContaining("is not assignable to type"),
      }),
      expect.objectContaining({ code: 2353, text: expect.stringContaining("'service'") }),
    ]);
  } finally {
    session.close();
  }
});
