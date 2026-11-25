// @vitest-environment node
import { build } from "vite";
import { expect, it } from "vitest";

it("keeps catalog descriptions outside the chat tool icon entry", async () => {
  const controller = new URL("../pages/chat/chat-tool-icon-controller.ts", import.meta.url)
    .pathname;
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      {
        name: "chat-tool-metadata-boundary",
        enforce: "pre",
        resolveId(source, importer) {
          // Keep the real metadata graph; unrelated view owners do not affect
          // whether icon membership pulls catalog presentation into boot.
          if (importer === controller && !source.includes("/src/agents/")) {
            return { id: source, external: true };
          }
          return null;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      rolldownOptions: {
        input: controller,
        preserveEntrySignatures: "strict",
      },
    },
  });
  if (Array.isArray(result) || !("output" in result)) {
    throw new Error("Expected one in-memory build");
  }
  const chunks = result.output.filter((asset) => asset.type === "chunk");
  const entry = chunks.find((chunk) => chunk.isEntry);
  expect(entry?.exports).toContain("createChatToolIcons");
  if (!entry) {
    throw new Error("Expected the chat tool icon entry");
  }
  const reachable = new Set<string>();
  const visit = (file: string) => {
    if (reachable.has(file)) {
      return;
    }
    reachable.add(file);
    chunks.find((chunk) => chunk.fileName === file)?.imports.forEach(visit);
  };
  visit(entry.fileName);
  const modules = chunks
    .filter((chunk) => reachable.has(chunk.fileName))
    .flatMap((chunk) =>
      Object.entries(chunk.modules)
        .filter(([, module]) => module.renderedLength > 0)
        .map(([id]) => id),
    );
  expect(modules).toContain(controller);
  expect(modules.some((id) => id.endsWith("/src/agents/tool-catalog.ts"))).toBe(false);
  expect(modules.some((id) => id.endsWith("/src/agents/tool-description-presets.ts"))).toBe(false);
  expect(modules.some((id) => id.endsWith("/src/agents/core-tool-facts.ts"))).toBe(true);
});
