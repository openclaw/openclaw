import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolvePreviewPython } from "../../scripts/lib/docs-preview-python.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const wrapper = path.resolve("scripts/docs-dev.mjs");

describe("docs source preview", () => {
  it.each([{ prefix: [] }, { prefix: ["--"] }])(
    "hands source edits and page selection to the publisher with prefix %j",
    ({ prefix }) => {
      const site = createTempDir("openclaw-docs-site-");
      fs.mkdirSync(path.join(site, "node_modules"));
      fs.writeFileSync(
        path.join(site, "package.json"),
        JSON.stringify({ scripts: { "docs:build:preview": "node preview.cjs" } }),
      );
      fs.writeFileSync(
        path.join(site, "preview.cjs"),
        `require("node:fs").writeFileSync("args.json", JSON.stringify(process.argv.slice(2)));`,
      );
      const before = fs.readFileSync("docs/docs.json");
      const result = spawnSync(
        process.execPath,
        [
          wrapper,
          ...prefix,
          "--site-repo",
          site,
          "--build-only",
          "--page",
          "gateway/configuration",
          "--page",
          "index",
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(site, "args.json"), "utf8"))).toEqual([
        "--source-root",
        process.cwd(),
        "--output-dir",
        path.join(process.cwd(), ".cache", "docs-preview"),
        "--page",
        "gateway/configuration",
        "--page",
        "index",
      ]);
      expect(fs.readFileSync("docs/docs.json")).toEqual(before);
    },
  );

  it("explains missing site dependencies and rejects invalid ports before building", () => {
    const site = createTempDir("openclaw-docs-site-missing-");
    fs.writeFileSync(
      path.join(site, "package.json"),
      JSON.stringify({ scripts: { "docs:build:preview": "node preview.cjs" } }),
    );
    const missing = spawnSync(process.execPath, [wrapper, "--site-repo", site, "--build-only"], {
      encoding: "utf8",
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("Run npm ci");
    const invalid = spawnSync(process.execPath, [wrapper, "--port", "0"], { encoding: "utf8" });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("--port must be an integer");
  });
});

describe("docs preview Python launcher", () => {
  const cases: {
    platform: NodeJS.Platform;
    versions: string[];
    expected: { command: string; args: string[] } | null;
  }[] = [
    { platform: "win32", versions: ["3"], expected: { command: "py", args: ["-3"] } },
    { platform: "win32", versions: ["missing", "3"], expected: { command: "python", args: [] } },
    {
      platform: "win32",
      versions: ["missing", "2", "3"],
      expected: { command: "python3", args: [] },
    },
    { platform: "darwin", versions: ["3\n"], expected: { command: "python3", args: [] } },
    { platform: "win32", versions: ["2\n", "2\n", "2\n"], expected: null },
  ];
  it.each(cases)(
    "requires Python 3 on $platform with probes $versions",
    ({ platform, versions, expected }) => {
      const remainingVersions = [...versions];
      const probe = vi.fn((_command: string, _args: string[]) => {
        const version = remainingVersions.shift();
        return {
          status: version === "missing" ? 1 : 0,
          stdout: version ?? "",
          stderr: "",
          pid: 1,
          signal: null,
          output: [],
        };
      });
      if (expected) {
        expect(resolvePreviewPython(platform, probe)).toEqual(expected);
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
    },
  );
});
