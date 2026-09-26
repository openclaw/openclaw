import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repositoryURL = "https://github.com/base-owner/base-repo";
const browseURL = "https://browse.invalid/browse-owner/browse-repo";

type Fixture = {
  originRemote?: string | null;
  nonGit?: boolean;
  ghRepo?: string;
  ghHost?: string;
  explicit?: string;
  selectedGit?: "OPENCLAW_PR_GIT" | "GIT_EXEC";
};

function readRepository(fixture: Fixture) {
  const dir = tempDirs.make("openclaw-pr-repository-locator-");
  const cwd = join(dir, "checkout");
  mkdirSync(cwd);
  if (!fixture.nonGit) {
    execFileSync("git", ["init", "-q"], { cwd });
    if (fixture.originRemote !== null) {
      execFileSync("git", ["remote", "add", "origin", fixture.originRemote ?? repositoryURL], {
        cwd,
      });
    }
  }
  const trace = join(dir, "gh-trace");
  const gitTrace = join(dir, "git-trace");
  writeFileSync(trace, "");
  writeFileSync(gitTrace, "");
  writeFileSync(
    join(dir, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({args, browser: Boolean(process.env.GH_BROWSER)}) + "\\n");
if (args[0] === "browse" && process.env.GH_BROWSER) {
  console.log(${JSON.stringify(browseURL)});
} else if (args[0] === "api" && args[1] === "--hostname" && /^repos\\/[^/]+\\/[^/]+$/.test(args[3])) {
  const name = args[3].slice(6);
  console.log(JSON.stringify({id: 1, full_name: name, html_url: "https://" + args[2] + "/" + name, node_id: "R_fixture"}));
} else {
  throw new Error("Unexpected gh invocation: " + JSON.stringify(args));
}
`,
    { mode: 0o755 },
  );
  if (fixture.selectedGit) {
    writeFileSync(
      join(cwd, "selected-git"),
      `#!${process.execPath}
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(gitTrace)}, JSON.stringify(args) + "\\n");
if (JSON.stringify(args) !== JSON.stringify(["remote", "get-url", "origin"])) process.exit(79);
console.log(${JSON.stringify(repositoryURL)});
`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "git"), "#!/bin/sh\necho 'poisoned PATH Git' >&2\nexit 79\n", {
      mode: 0o755,
    });
  }
  const result = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "scripts/pr-lib/github.mjs"),
      "read",
      "repo",
      "view",
      "--json",
      "url",
      ...(fixture.explicit ? ["--repo", fixture.explicit] : []),
    ],
    {
      cwd,
      env: {
        ...process.env,
        GH_REPO: fixture.ghRepo ?? "",
        GH_HOST: fixture.ghHost ?? "",
        GH_BROWSER: "",
        OPENCLAW_GH_BIN: "",
        OPENCLAW_PR_GIT: "",
        GIT_EXEC: "",
        ...(fixture.selectedGit ? { [fixture.selectedGit]: "./selected-git" } : {}),
        PATH: `${dir}:${process.env.PATH}`,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  const calls = readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; browser: boolean });
  const gitCalls = readFileSync(gitTrace, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  return { ...result, calls, gitCalls };
}

describe("PR repository locator through the CLI", () => {
  it.each([
    { originRemote: `${repositoryURL}.git`, host: "github.com" },
    { originRemote: "git@github.com:base-owner/base-repo.git", host: "github.com" },
    {
      originRemote: "ssh://git@github.enterprise.invalid:2222/base-owner/base-repo",
      host: "github.enterprise.invalid",
    },
    {
      originRemote: "https://github.enterprise.invalid:8443/base-owner/base-repo",
      host: "github.enterprise.invalid:8443",
    },
    { originRemote: "http://github.com/base-owner/base-repo.git/", host: "github.com" },
    { originRemote: "ssh://user@github.com/base-owner/base-repo.git/", host: "github.com" },
    { originRemote: repositoryURL, ghHost: "GITHUB.COM", host: "github.com" },
  ])("resolves $originRemote before browse", ({ host, ...fixture }) => {
    const result = readRepository(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ url: `https://${host}/base-owner/base-repo` });
    expect(result.calls.map((call) => call.args)).toEqual([
      ["api", "--hostname", host, "repos/base-owner/base-repo", "-H", "Cache-Control: max-age=0"],
    ]);
  });

  it.each([
    { ghRepo: repositoryURL },
    { ghRepo: "github.com/base-owner/base-repo.git/" },
    { explicit: repositoryURL, ghRepo: "https://ignored.invalid/ignored/repo" },
  ])("prefers a qualified selection without consulting Git: %j", (selection) => {
    const result = readRepository({
      ...selection,
      originRemote: "https://github.com/other/repo",
      selectedGit: "OPENCLAW_PR_GIT",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ url: repositoryURL });
    expect(result.calls.map((call) => call.args[0])).toEqual(["api"]);
    expect(result.gitCalls).toEqual([]);
  });

  it.each([
    { originRemote: null },
    { nonGit: true },
    { originRemote: "file:///tmp/x" },
    { originRemote: "/tmp/x" },
    { originRemote: "git://github.com/base-owner/base-repo" },
    { ghHost: "github.enterprise.invalid" },
    { ghRepo: "base-owner/base-repo" },
    { explicit: "base-owner/base-repo" },
  ] satisfies Fixture[])("falls back to gh's host resolution: %j", (fixture) => {
    const result = readRepository(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ url: browseURL });
    expect(result.calls).toEqual([
      {
        args: ["browse", ...("explicit" in fixture ? ["--repo", fixture.explicit] : [])],
        browser: true,
      },
      {
        args: [
          "api",
          "--hostname",
          "browse.invalid",
          "repos/browse-owner/browse-repo",
          "-H",
          "Cache-Control: max-age=0",
        ],
        browser: false,
      },
    ]);
  });

  it.each(["OPENCLAW_PR_GIT", "GIT_EXEC"] as const)(
    "uses %s relative to the child cwd instead of poisoned PATH Git",
    (selectedGit) => {
      const result = readRepository({ selectedGit });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({ url: repositoryURL });
      expect(result.calls.map((call) => call.args[0])).toEqual(["api"]);
      expect(result.gitCalls).toEqual([["remote", "get-url", "origin"]]);
    },
  );
});
