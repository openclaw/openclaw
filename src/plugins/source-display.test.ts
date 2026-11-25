import assert from "node:assert/strict";
import path from "node:path";
import { expect, it } from "vitest";
import { withPathResolutionEnv } from "../test-utils/env.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginSourceRoots } from "./roots.js";
import { formatPluginSourceForTable, resolvePluginSourceRoots } from "./source-display.js";

const roots = {
  stock: path.resolve(path.sep, "opt", "homebrew", "lib", "node_modules", "openclaw", "extensions"),
  global: path.resolve(path.sep, "Users", "x", ".openclaw", "extensions"),
  workspace: path.resolve(path.sep, "Users", "x", "ws", ".openclaw", "extensions"),
};
const format = (origin: PluginOrigin, source: string, sourceRoots: PluginSourceRoots = roots) =>
  formatPluginSourceForTable({ origin, source }, sourceRoots);

it.each([
  { directory: "p-home", expectedRoot: "$OPENCLAW_HOME" },
  { directory: "p-home-other", expectedRoot: path.resolve(path.sep, "tmp", "p-home-other") },
])("preserves source identity for $directory", ({ directory, expectedRoot }) => {
  const homeDir = path.resolve(path.sep, "tmp", "p-home");
  const source = path.resolve(path.sep, "tmp", directory, "p", "index.js");
  const out = withPathResolutionEnv(homeDir, { OPENCLAW_HOME: homeDir }, () =>
    format("config", source),
  );

  expect(out).toEqual({ value: path.join(expectedRoot, "p", "index.js") });
});

it.each([
  { origin: "bundled", rootKey: "stock", file: "index.ts" },
  { origin: "workspace", rootKey: "workspace", file: "index.ts" },
  { origin: "global", rootKey: "global", file: "index.js" },
] as const)("shortens $origin sources under their root", ({ origin, rootKey, file }) => {
  expect(format(origin, path.join(roots[rootKey], "demo", file))).toEqual({
    value: `${rootKey}:demo/${file}`,
    rootKey,
  });
});

const root = path.resolve(path.sep, "plugins");
const file = path.join(root, "demo.ts");
it.each([
  ["bundled", {}, file],
  ["workspace", {}, file],
  ["global", { global: "" }, file],
  ["bundled", { stock: root }, root],
  ["workspace", { workspace: root }, path.join(`${root}-other`, "demo.ts")],
  ["config", {}, file],
] as const)("preserves %s fallback with %j roots for %s", (origin, overrides, source) => {
  expect(format(origin, source, { global: root, ...overrides })).toEqual({ value: source });
});

it("middle-truncates long out-of-root source paths for table rows", () => {
  const source = path.join(roots.workspace, "very-long-plugin-directory-name", "index.ts");
  const out = format("config", source);
  expect(out.rootKey).toBeUndefined();
  expect(out.value.length).toBeLessThanOrEqual(48);
  expect(out.value).toContain("...");
  expect(out.value.startsWith(path.join(path.sep, "Users", "x"))).toBe(true);
  expect(out.value.endsWith("index.ts")).toBe(true);
});

it("ignores untrusted explicit env override for the stock source root", () => {
  const homeDir = path.resolve(path.sep, "tmp", "openclaw-home");
  const rawEnv = {
    OPENCLAW_BUNDLED_PLUGINS_DIR: "~/bundled",
    OPENCLAW_STATE_DIR: "~/state",
  };
  const stock = withPathResolutionEnv(homeDir, rawEnv, resolveBundledPluginsDir);
  assert(stock, "expected bundled plugin source root");
  expect(
    withPathResolutionEnv(homeDir, rawEnv, (env) =>
      resolvePluginSourceRoots({ env, workspaceDir: "~/ws" }),
    ),
  ).toEqual({
    stock,
    global: path.join(homeDir, "state", "extensions"),
    workspace: path.join(homeDir, "ws", ".openclaw", "extensions"),
  });
});
