import assert from "node:assert/strict";
import path from "node:path";
import { createVitest } from "vitest/node";

const topLevelRoot = process.argv[2];
if (!topLevelRoot) {
  throw new Error("Expected a top-level project root");
}
const testRoot = process.argv[3];
if (!testRoot) {
  throw new Error("Expected a test project root");
}
const topLevelDescriptorRoot = path.relative(process.cwd(), topLevelRoot);
const testDescriptorRoot = path.relative(process.cwd(), testRoot);
const browser = process.argv[4] ?? "chromium";
const config = path.resolve(
  browser === "webkit"
    ? "test/vitest/vitest.ui-browser-webkit.config.ts"
    : "test/vitest/vitest.ui-browser.config.ts",
);
let standalone;
for (const options of [
  { config },
  { config: false, projects: [{ config }] },
  { config: false, projects: [{ config, root: topLevelDescriptorRoot }] },
  { config: false, projects: [{ config, test: { root: testDescriptorRoot } }] },
]) {
  const ctx = await createVitest({
    ...options,
    project: [browser],
    watch: false,
    reporters: [],
    configLoader: "runner",
    api: false,
  });
  try {
    const specifications = await ctx.globTestSpecifications();
    const expectedRoot = options.projects?.[0]?.root
      ? topLevelRoot
      : options.projects?.[0]?.test?.root
        ? testRoot
        : path.resolve("ui");
    assert.deepEqual(
      ctx.projects.map((project) => ({
        name: project.name,
        root: project.config.root,
        viteRoot: project.vite.config.root,
        setupFiles: project.config.setupFiles,
      })),
      [
        {
          name: browser,
          root: expectedRoot,
          viteRoot: expectedRoot,
          setupFiles: [path.join(expectedRoot, "src/test-helpers/dom.setup.ts")],
        },
      ],
    );
    const files = specifications.map((spec) => spec.moduleId).toSorted();
    if (!standalone) {
      standalone = files;
      assert(
        files.includes(
          path.join(
            expectedRoot,
            browser === "webkit"
              ? "src/components/solid/menu-navigation.browser.test.tsx"
              : "src/components/markdown-mermaid.runtime.browser.test.ts",
          ),
        ),
      );
    } else if (expectedRoot === path.resolve("ui")) {
      assert.deepEqual(files, standalone);
    }
  } finally {
    await ctx.close();
  }
}
