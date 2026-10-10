// Tests get-reply import boundaries for lazy runtime and side-effect control.
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createRuntimeImportGraph } from "../../../scripts/lib/runtime-import-closure.mts";

const getReplyPath = resolve(dirname(fileURLToPath(import.meta.url)), "get-reply.ts");
function collectStaticImportPaths(entryPath: string): Set<string> {
  const paths = new Set([entryPath]);
  const root = resolve(dirname(getReplyPath), "../../..");
  const graph = createRuntimeImportGraph(root, [entryPath], { sourceImports: true });
  try {
    for (const filePath of paths) {
      for (const { specifier, resolvedFileName } of graph.dependencies(filePath)) {
        if (!specifier.startsWith(".")) {
          continue;
        }
        const resolved = expectDefined(resolvedFileName, `${filePath} -> ${specifier}`);
        if (!/\.d\.[cm]?ts$/.test(resolved)) {
          paths.add(resolved);
        }
      }
    }
    return paths;
  } finally {
    graph.close();
  }
}

describe("get-reply module imports", () => {
  it("keeps skill discovery and dispatch out of the inline-actions static import closure", () => {
    const skillsRoot = resolve(dirname(getReplyPath), "../../skills");
    const paths = collectStaticImportPaths(
      resolve(dirname(getReplyPath), "get-reply-inline-actions.ts"),
    );
    const eagerSkillRuntime = [...paths]
      .map((filePath) => relative(skillsRoot, filePath).replaceAll("\\", "/"))
      .filter((filePath) =>
        /^(?:loading\/|library\/|runtime\/|discovery\/(?:chat-commands|command-specs)(?:\.|\/))/.test(
          filePath,
        ),
      );

    expect(eagerSkillRuntime).toEqual([]);
  });
});
