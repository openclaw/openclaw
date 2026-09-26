// Verifies plugin source display formatting.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withPathResolutionEnv } from "../test-utils/env.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { formatPluginSourceForTable, resolvePluginSourceRoots } from "./source-display.js";

const PLUGIN_SOURCE_ROOTS = {
  stock: path.resolve(path.sep, "opt", "homebrew", "lib", "node_modules", "openclaw", "extensions"),
  global: path.resolve(path.sep, "Users", "x", ".openclaw", "extensions"),
  workspace: path.resolve(path.sep, "Users", "x", "ws", ".openclaw", "extensions"),
};

describe("formatPluginSourceForTable", () => {
  it.each([
    { directory: "p-home", expectedRoot: "$OPENCLAW_HOME" },
    { directory: "p-home-other", expectedRoot: path.resolve(path.sep, "tmp", "p-home-other") },
  ])("preserves source identity for $directory", ({ directory, expectedRoot }) => {
    const homeDir = path.resolve(path.sep, "tmp", "p-home");
    const source = path.resolve(path.sep, "tmp", directory, "p", "index.js");
    const out = withPathResolutionEnv(homeDir, { OPENCLAW_HOME: homeDir }, () =>
      formatPluginSourceForTable({ origin: "config", source }, PLUGIN_SOURCE_ROOTS),
    );

    expect(out).toEqual({ value: path.join(expectedRoot, "p", "index.js") });
  });

  it.each([
    { origin: "bundled", rootKey: "stock", file: "index.ts" },
    { origin: "workspace", rootKey: "workspace", file: "index.ts" },
    { origin: "global", rootKey: "global", file: "index.js" },
  ] as const)("shortens $origin sources under their root", ({ origin, rootKey, file }) => {
    expect(
      formatPluginSourceForTable(
        { origin, source: path.join(PLUGIN_SOURCE_ROOTS[rootKey], "demo", file) },
        PLUGIN_SOURCE_ROOTS,
      ),
    ).toEqual({ value: `${rootKey}:demo/${file}`, rootKey });
  });

  it.each([
    { origin: "bundled", rootKey: "stock", kind: "missing" },
    { origin: "workspace", rootKey: "workspace", kind: "missing" },
    { origin: "global", rootKey: "global", kind: "empty" },
    { origin: "bundled", rootKey: "stock", kind: "exact" },
    { origin: "workspace", rootKey: "workspace", kind: "sibling" },
    { origin: "config", rootKey: "global", kind: "configured" },
  ] as const)(
    "keeps the fallback for $origin sources with $kind roots",
    ({ origin, rootKey, kind }) => {
      const root = path.resolve(path.sep, "plugins");
      const source =
        kind === "exact" ? root : path.join(kind === "sibling" ? `${root}-other` : root, "demo.ts");
      const roots = {
        global: root,
        ...(kind === "missing" ? {} : { [rootKey]: kind === "empty" ? "" : root }),
      };
      expect(formatPluginSourceForTable({ origin, source }, roots)).toEqual({ value: source });
    },
  );

  it("middle-truncates long out-of-root source paths for table rows", () => {
    const longSource = path.join(
      path.sep,
      "Users",
      "x",
      "some",
      "deeply",
      "nested",
      "project",
      "checkout",
      "extensions",
      "very-long-plugin-directory-name",
      "index.ts",
    );
    const out = formatPluginSourceForTable(
      { origin: "config", source: longSource },
      {
        global: PLUGIN_SOURCE_ROOTS.global,
      },
    );
    expect(out.rootKey).toBeUndefined();
    expect(out.value.length).toBeLessThanOrEqual(48);
    expect(out.value).toContain("...");
    // Both path ends stay visible so rows remain identifiable.
    expect(out.value.startsWith(path.join(path.sep, "Users", "x"))).toBe(true);
    expect(out.value.endsWith("index.ts")).toBe(true);
  });

  it("ignores untrusted explicit env override for the stock source root", () => {
    const homeDir = path.resolve(path.sep, "tmp", "openclaw-home");
    const rawEnv = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: "~/bundled",
      OPENCLAW_STATE_DIR: "~/state",
    } as NodeJS.ProcessEnv;
    const stock = withPathResolutionEnv(homeDir, rawEnv, (env) => resolveBundledPluginsDir(env));
    if (!stock) {
      throw new Error("expected bundled plugin source root");
    }
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
});
