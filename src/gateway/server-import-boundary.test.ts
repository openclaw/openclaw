import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntimeImportGraph } from "../../scripts/lib/runtime-import-closure.mts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const graph = createRuntimeImportGraph(
  repoRoot,
  [
    "src/gateway/method-scopes.ts",
    "src/gateway/server-close.runtime.ts",
    "src/gateway/server-methods/sessions-create.ts",
  ],
  { sourceImports: true },
);
afterAll(() => graph.close());

function collectStaticValueImports(entryRelativePath: string): string[] {
  const files = new Set([entryRelativePath]);
  for (const file of files) {
    for (const { specifier, resolvedFileName } of graph.dependencies(file)) {
      if (specifier.startsWith(".") && resolvedFileName) {
        files.add(path.relative(repoRoot, resolvedFileName));
      }
    }
  }
  return [...files];
}

describe("gateway startup import boundaries", () => {
  it("keeps static method policy independent of session storage", () => {
    const modules = collectStaticValueImports("src/gateway/method-scopes.ts");
    expect(
      modules.filter((file) => file.startsWith(path.join("src", "config", "sessions") + path.sep)),
    ).toEqual([]);
  });

  it("keeps ordinary session lifecycle code out of the prepared shutdown graph", () => {
    expect(collectStaticValueImports("src/gateway/server-close.runtime.ts")).not.toContain(
      "src/gateway/session-reset-service.ts",
    );
  });

  it("keeps agent execution out of the session creation import graph", () => {
    const modules = collectStaticValueImports("src/gateway/server-methods/sessions-create.ts");

    expect(modules).not.toContain("src/gateway/server-methods/chat-send-external-entry.ts");
    expect(modules).not.toContain("src/gateway/server-methods/chat-send-handler.ts");
    expect(modules).not.toContain("src/agents/embedded-agent-runner/run.ts");
    expect(modules).not.toContain("src/agents/embedded-agent-runner/compact.queued.ts");
  });
});
