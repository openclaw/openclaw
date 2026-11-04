import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { createRuntimeImportGraph } from "../../scripts/lib/runtime-import-closure.mts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const entries = [
  "src/gateway/http-image-response.ts",
  "src/gateway/plugin-icon-http.ts",
  "src/gateway/control-ui-link-preview.ts",
  "src/gateway/assistant-avatar-thumbnail.runtime.ts",
];
const graph = createRuntimeImportGraph(repoRoot, entries, { sourceImports: true });
afterAll(() => graph.close());

it("keeps binary detection out of every Gateway image owner's static import graph", () => {
  const files = new Set(entries);
  const eagerDetectorImports: string[] = [];
  for (const file of files) {
    for (const { specifier, resolvedFileName } of graph.dependencies(file)) {
      if (specifier === "file-type") {
        eagerDetectorImports.push(file);
      }
      if (specifier.startsWith(".") && resolvedFileName) {
        files.add(path.relative(repoRoot, resolvedFileName));
      }
    }
  }
  expect(eagerDetectorImports).toEqual([]);
});

const detector = vi.hoisted(() => ({
  loaded: false,
  error: new Error("synthetic image detection failure"),
}));

// mock-isolation: Observe detector initialization and preserve a caller-visible detection error.
vi.mock("file-type", () => {
  detector.loaded = true;
  return {
    fileTypeFromBuffer: async () => {
      throw detector.error;
    },
  };
});

it("loads the binary detector only for nonempty raster input and preserves its failure", async () => {
  const { resolveHttpImageRepresentation, resolveHttpImageMimeType, HTTP_IMAGE_MAX_BYTES } =
    await import("./http-image-response.js");
  expect(detector.loaded).toBe(false);
  expect(resolveHttpImageMimeType("image/vnd.microsoft.icon")).toBe("image/x-icon");
  await expect(
    resolveHttpImageRepresentation("empty.png", Buffer.alloc(0)),
  ).resolves.toBeUndefined();
  await expect(
    resolveHttpImageRepresentation("large.png", Buffer.alloc(HTTP_IMAGE_MAX_BYTES + 1)),
  ).resolves.toBeUndefined();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const image = await resolveHttpImageRepresentation("icon.svg", svg);
  expect(image?.body).toBe(svg);
  expect(image?.contentType).toBe("image/svg+xml");
  expect(detector.loaded).toBe(false);
  await expect(resolveHttpImageRepresentation("icon.png", Buffer.from([1]))).rejects.toBe(
    detector.error,
  );
  expect(detector.loaded).toBe(true);
});
