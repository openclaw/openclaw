import path from "node:path";
import { expect, it } from "vitest";
import { createNativeTypeScriptProject } from "../../scripts/lib/native-typescript.mts";

it("preserves strict local-service authority and embedding deadline compatibility", () => {
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
import {
  EMBEDDING_DEADLINE_CONTROL,
  type EmbeddingDeadlineControl,
  type EmbeddingDeadlineControlOptions,
  type EmbeddingProviderCallOptions,
} from "./embedding-providers.js";
import {
  MEMORY_SEARCH_DEADLINE_CONTROL,
  type MemorySearchDeadlineControl,
  type MemorySearchDeadlineControlOptions,
} from "./memory-core-host-engine-storage.js";
declare const control: MemorySearchDeadlineControl;
declare const embeddingControl: EmbeddingDeadlineControl;
declare const useEmbedding: (options: EmbeddingProviderCallOptions) => void;
declare const useMemory: (options: MemorySearchDeadlineControlOptions) => void;
declare const useDeadline: (options: EmbeddingDeadlineControlOptions) => void;
declare const useKey: (key: typeof EMBEDDING_DEADLINE_CONTROL) => void;
useKey(MEMORY_SEARCH_DEADLINE_CONTROL);
useEmbedding({ [MEMORY_SEARCH_DEADLINE_CONTROL]: control });
useMemory({ [EMBEDDING_DEADLINE_CONTROL]: embeddingControl });
useDeadline({ [MEMORY_SEARCH_DEADLINE_CONTROL]: control });
const unsubscribe = embeddingControl.subscribe((action) => control.report(action));
unsubscribe();
embeddingControl.report("invalid");
useEmbedding({ [MEMORY_SEARCH_DEADLINE_CONTROL]: { report: control.report } });
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
      expect.objectContaining({ code: 2345, text: expect.stringContaining('"invalid"') }),
      expect.objectContaining({ code: 2741, text: expect.stringContaining("subscribe") }),
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
