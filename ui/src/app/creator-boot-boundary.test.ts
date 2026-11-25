// @vitest-environment node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, normalizePath } from "vite";
import { expect, it } from "vitest";
import { controlUiSolidPlugin } from "../../config/control-ui-solid.ts";

it("keeps creator construction outside the roster and dormant chat review entries", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const entries = {
    roster: path.join(root, "components/sidebar-agent-roster.tsx"),
    review: path.join(root, "pages/templates/creator-review.tsx"),
  };
  const owners = new Set([
    ...Object.values(entries),
    ...["creator-flow.ts", "creator-owner.ts", "creator-publication.ts", "draft-navigation.ts"].map(
      (file) => path.join(root, "pages/templates", file),
    ),
    ...["en-agents-home.ts", "en-template-creator.ts"].map((file) =>
      path.join(root, "i18n/locales", file),
    ),
  ]);
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      ...controlUiSolidPlugin(),
      {
        name: "creator-boot-boundary",
        enforce: "pre",
        resolveId(source, importer) {
          // Preserve both real ingress edges and their creator/catalog owners.
          // Unrelated shell, rendering, and Gateway dependencies are not this boundary.
          if (importer && !owners.has(path.resolve(path.dirname(importer), source))) {
            return { id: source, external: true };
          }
          return null;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      rolldownOptions: { input: entries, preserveEntrySignatures: "strict" },
    },
  });
  if (Array.isArray(result) || !("output" in result)) {
    throw new Error("Expected one in-memory build");
  }
  const chunks = result.output.filter((asset) => asset.type === "chunk");
  const reachable = new Set<string>();
  const visit = (file: string) => {
    if (reachable.has(file)) {
      return;
    }
    reachable.add(file);
    chunks.find((chunk) => chunk.fileName === file)?.imports.forEach(visit);
  };
  for (const [name, exported] of [
    ["roster", "SidebarAgentRoster"],
    ["review", "TemplateCreatorReview"],
  ]) {
    const entry = chunks.find((chunk) => chunk.isEntry && chunk.name === name);
    expect(entry?.exports).toContain(exported);
    if (!entry) {
      throw new Error(`Missing ${name} entry`);
    }
    visit(entry.fileName);
  }
  const modules = chunks
    .filter((chunk) => reachable.has(chunk.fileName))
    .flatMap((chunk) =>
      Object.entries(chunk.modules)
        .filter(([, module]) => module.renderedLength > 0)
        .map(([id]) => id),
    );
  expect(modules).toEqual(expect.arrayContaining(Object.values(entries).map(normalizePath)));
  expect(modules.some((id) => id.endsWith("/pages/templates/creator-flow.ts"))).toBe(false);
  expect(modules.some((id) => id.endsWith("/i18n/locales/en-template-creator.ts"))).toBe(false);
  expect(modules.some((id) => id.endsWith("/pages/templates/creator-owner.ts"))).toBe(true);
  expect(modules.some((id) => id.endsWith("/pages/templates/creator-publication.ts"))).toBe(true);
});
