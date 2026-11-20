import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderDocsSkillMap } from "../../scripts/docs-skill-map.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { files } from "./docs-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = path.resolve(import.meta.dirname, "../../scripts/docs-skill-map.mjs");
const repoRoot = path.resolve(import.meta.dirname, "../..");
const MAP_PATH = "skills/openclaw-docs/references/docs-map.md";

function writeDocsJson(root: string, tabs: unknown[]) {
  files(path.join(root, "docs")).write(
    "docs.json",
    JSON.stringify({ navigation: { languages: [{ language: "en", tabs }] } }),
  );
}

function makeFixture() {
  const root = tempDirs.make("openclaw-docs-skill-map-");
  const docs = files(path.join(root, "docs"));
  for (const page of ["index", "a/one", "a/two", "b/three", "a/four", "nested/deep"]) {
    docs.write(`${page}.md`, "# Page\n");
  }
  docs.write("mdx-page.mdx", "# Page\n");
  writeDocsJson(root, [
    {
      tab: "Main",
      groups: [
        {
          group: "Core",
          pages: [
            "index",
            "a/one",
            "a/two",
            "b/three",
            "a/four",
            { group: "Nested", pages: ["nested/deep"] },
            "mdx-page",
            "site/published-only",
          ],
        },
        { group: "Remote", pages: ["site/a", "site/b"] },
      ],
    },
  ]);
  return root;
}

function runCli(cwd: string, arg: string) {
  return spawnSync(process.execPath, [scriptPath, arg], { cwd, encoding: "utf8" });
}

describe("docs-skill-map", () => {
  it("compresses groups, flattens nested groups, and marks pages without a file as web only", () => {
    const root = makeFixture();
    expect(renderDocsSkillMap(path.join(root, "docs"))).toBe(
      [
        "# OpenClaw docs map",
        "",
        "Generated from `docs/docs.json` by `pnpm docs:skill-map:gen`. Do not edit by hand.",
        "Page `x/y` is `<docs>/x/y.md` locally and `https://docs.openclaw.ai/x/y` on the web.",
        "Pages marked (web only) are published but not shipped in local docs.",
        "",
        "## Main",
        "",
        "- Core: index mdx-page a/{one,two,four} b/three nested/deep (web only: site/published-only)",
        "- Remote: (web only: site/{a,b})",
        "",
      ].join("\n"),
    );
  });

  it("fails --check when the committed map is stale and passes again after --write", () => {
    const root = makeFixture();
    expect(runCli(root, "--check").status).toBe(1);

    expect(runCli(root, "--write").status).toBe(0);
    expect(runCli(root, "--check").status).toBe(0);

    files(path.join(root, "docs")).write("a/five.md", "# Page\n");
    writeDocsJson(root, [{ tab: "Main", groups: [{ group: "Core", pages: ["index", "a/five"] }] }]);
    const stale = runCli(root, "--check");
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("pnpm docs:skill-map:gen");

    expect(runCli(root, "--write").status).toBe(0);
    expect(runCli(root, "--check").status).toBe(0);
  });

  it("keeps the committed OpenClaw map current and resolvable", () => {
    const docsDir = path.join(repoRoot, "docs");
    const committed = fs.readFileSync(path.join(repoRoot, MAP_PATH), "utf8");
    expect(committed).toBe(renderDocsSkillMap(docsDir));

    const unresolved: string[] = [];
    for (const line of committed.split("\n").filter((entry) => entry.startsWith("- "))) {
      const local = line.slice(line.indexOf(":") + 1).split("(web only:")[0] ?? "";
      for (const token of local.trim().split(/\s+/).filter(Boolean)) {
        const [, dir, leaves] = /^(.+)\/\{(.+)\}$/.exec(token) ?? [];
        const pages = dir && leaves ? leaves.split(",").map((leaf) => `${dir}/${leaf}`) : [token];
        for (const page of pages) {
          if (!["md", "mdx"].some((ext) => fs.existsSync(path.join(docsDir, `${page}.${ext}`)))) {
            unresolved.push(page);
          }
        }
      }
    }
    expect(unresolved).toEqual([]);
  });
});
