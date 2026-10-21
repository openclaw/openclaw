import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolvePreviewPython } from "../../scripts/lib/docs-preview-python.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const wrapper = path.resolve("scripts/docs-dev.mjs");
const run = (...args: string[]) =>
  spawnSync(process.execPath, [wrapper, ...args], { encoding: "utf8" });
function makeSite(installed = false) {
  const site = createTempDir("openclaw-docs-site-");
  fs.writeFileSync(
    path.join(site, "package.json"),
    JSON.stringify({ scripts: { "docs:build:preview": "node preview.cjs" } }),
  );
  if (installed) {
    fs.mkdirSync(path.join(site, "node_modules"));
    fs.writeFileSync(
      path.join(site, "preview.cjs"),
      `require("node:fs").writeFileSync("args.json", JSON.stringify(process.argv.slice(2)));`,
    );
  }
  return site;
}

it.each([{ prefix: [] }, { prefix: ["--"] }])(
  "hands source edits and page selection to the publisher with prefix %j",
  ({ prefix }) => {
    const site = makeSite(true);
    const before = fs.readFileSync("docs/docs.json");
    const pages = ["--page", "gateway/configuration", "--page", "index"];
    const result = run(...prefix, "--site-repo", site, "--build-only", ...pages);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(site, "args.json"), "utf8"))).toEqual([
      "--source-root",
      process.cwd(),
      "--output-dir",
      path.join(process.cwd(), ".cache", "docs-preview"),
      ...pages,
    ]);
    expect(fs.readFileSync("docs/docs.json")).toEqual(before);
  },
);

it("explains missing site dependencies and rejects invalid ports before building", () => {
  const missing = run("--site-repo", makeSite(), "--build-only");
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("Run npm ci");
  const invalid = run("--port", "0");
  expect(invalid.status).not.toBe(0);
  expect(invalid.stderr).toContain("--port must be an integer");
});
it.each<[NodeJS.Platform, string[], string | null]>([
  ["win32", ["3"], "py"],
  ["win32", ["missing", "3"], "python"],
  ["win32", ["missing", "2", "3"], "python3"],
  ["darwin", ["3\n"], "python3"],
  ["win32", ["2\n", "2\n", "2\n"], null],
])("requires Python 3 on %s with probes %j", (platform, versions, command) => {
  const remainingVersions = [...versions];
  const probe = vi.fn((_command: string, _args: string[]) => {
    const version = remainingVersions.shift();
    const status = version === "missing" ? 1 : 0;
    return { status, stdout: version ?? "", stderr: "", pid: 1, signal: null, output: [] };
  });
  if (command) {
    expect(resolvePreviewPython(platform, probe)).toEqual({
      command,
      args: command === "py" ? ["-3"] : [],
    });
  } else {
    expect(() => resolvePreviewPython(platform, probe)).toThrow("Python 3 is required");
    expect(probe).toHaveBeenCalledTimes(3);
  }
  expect(probe.mock.calls.map((call) => call[0])).toEqual(
    (platform === "win32" ? ["py", "python", "python3"] : ["python3"]).slice(
      0,
      probe.mock.calls.length,
    ),
  );
});
