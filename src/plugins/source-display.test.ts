import path from "node:path";
import { describe, expect, it } from "vitest";
import { withPathResolutionEnv } from "../test-utils/env.js";
import { formatPluginSourceForTable, resolvePluginSourceRoots } from "./source-display.js";

function createPluginSourceRoots() {
  const stockRoot = path.resolve(
    path.sep,
    "opt",
    "homebrew",
    "lib",
    "node_modules",
    "openclaw",
    "extensions",
  );
  const globalRoot = path.resolve(path.sep, "Users", "x", ".openclaw", "extensions");
  const workspaceRoot = path.resolve(path.sep, "Users", "x", "ws", ".openclaw", "extensions");
  return {
    stock: stockRoot,
    global: globalRoot,
    workspace: workspaceRoot,
  };
}

function expectFormattedSource(params: {
  origin: "bundled" | "workspace" | "global";
  sourceKey: "stock" | "workspace" | "global";
  dirName: string;
  fileName: string;
  expectedValue: string;
  expectedRootKey: "stock" | "workspace" | "global";
}) {
  const roots = createPluginSourceRoots();
  const out = formatPluginSourceForTable(
    {
      origin: params.origin,
      source: path.join(roots[params.sourceKey], params.dirName, params.fileName),
    },
    roots,
  );
  expect(out.value).toBe(params.expectedValue);
  expect(out.rootKey).toBe(params.expectedRootKey);
}

describe("formatPluginSourceForTable", () => {
  it.each([
    {
      name: "bundled plugin sources under the stock root",
      origin: "bundled" as const,
      sourceKey: "stock" as const,
      dirName: "demo-stock",
      fileName: "index.ts",
      expectedValue: "stock:demo-stock/index.ts",
      expectedRootKey: "stock" as const,
    },
    {
      name: "workspace plugin sources under the workspace root",
      origin: "workspace" as const,
      sourceKey: "workspace" as const,
      dirName: "demo-workspace",
      fileName: "index.ts",
      expectedValue: "workspace:demo-workspace/index.ts",
      expectedRootKey: "workspace" as const,
    },
    {
      name: "global plugin sources under the global root",
      origin: "global" as const,
      sourceKey: "global" as const,
      dirName: "demo-global",
      fileName: "index.js",
      expectedValue: "global:demo-global/index.js",
      expectedRootKey: "global" as const,
    },
  ])(
    "shortens $name",
    ({ origin, sourceKey, dirName, fileName, expectedValue, expectedRootKey }) => {
      expectFormattedSource({
        origin,
        sourceKey,
        dirName,
        fileName,
        expectedValue,
        expectedRootKey,
      });
    },
  );

  it("resolves source roots from an explicit env override", () => {
    const homeDir = path.resolve(path.sep, "tmp", "openclaw-home");
    const roots = withPathResolutionEnv(
      homeDir,
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: "~/bundled",
        OPENCLAW_STATE_DIR: "~/state",
      },
      (env) =>
        resolvePluginSourceRoots({
          env,
          workspaceDir: "~/ws",
        }),
    );

    expect(roots).toEqual({
      stock: path.join(homeDir, "bundled"),
      global: path.join(homeDir, "state", "extensions"),
      workspace: path.join(homeDir, "ws", ".openclaw", "extensions"),
    });
  });
});
