import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// No real Git, npm, or GitHub calls: exercise the CLI's preflight and dry-run
// path with successful external prerequisites and one isolated Git failure.
const sources = JSON.parse(readFileSync(process.env.MOCK_PREFLIGHT_SOURCES, "utf8"));
const failure = process.env.MOCK_PREFLIGHT_FAILURE;
const candidateSha = "a".repeat(40);
const mainSha = "b".repeat(40);
let packageReads = 0;
const respond = (file, inputArgs) => {
  const args = inputArgs[0] === "-C" ? inputArgs.slice(2) : inputArgs;
  const fail = (stage) => ({ status: 128, stdout: "", stderr: "fixture Git " + stage + " failed" });
  if (file === "npm") {
    return { status: 0, stdout: '["2026.6.34","2026.7.8","2026.7.9"]', stderr: "" };
  }
  if (file !== "git") {
    throw new Error("Unexpected external command: " + file);
  }
  let stdout = "";
  if (args[0] === "init") {
    // Bare-SHA prerequisite, without creating or fetching a repository.
  } else if (args[0] === "fetch") {
    if (failure === "main-fetch" && args.includes("refs/heads/main:refs/remotes/origin/main")) {
      return fail("main-fetch");
    }
  } else if (args[0] === "rev-parse") {
    if (args.at(-1) === "origin/main^{commit}" && failure === "resolve") {
      return fail("resolve");
    }
    stdout =
      args.at(-1) === "origin/main^{commit}" ? mainSha : args.at(-1).replace("^{commit}", "");
  } else if (args[0] === "ls-remote") {
    stdout = candidateSha + "\trefs/heads/release/2026.8.1";
  } else if (args[0] === "cat-file" && args[1] === "blob") {
    stdout = sources["CHANGELOG.md"];
  } else if (["merge-base", "cat-file"].includes(args[0])) {
    return { status: 0, stdout, stderr: "" };
  } else if (args[0] === "rev-list") {
    if (failure === "rev-list") {
      return fail("rev-list");
    }
    stdout = "1";
  } else if (args[0] === "diff") {
    const stage = args.includes("--shortstat") ? "shortstat" : "dirstat";
    if (failure === stage) {
      return fail(stage);
    }
    stdout = stage === "shortstat" ? "1 file changed, 1 insertion(+)" : "100.0% scripts/";
  } else if (args[0] === "show") {
    const path = args[1].slice(41);
    if (path === "package.json" && ++packageReads > 1 && failure === "package-source") {
      return fail("package-source");
    }
    if (path === "packages/ai/package.json") {
      return fail("missing optional AI package");
    }
    if (!(path in sources)) {
      return fail("missing " + path);
    }
    stdout = sources[path];
  } else if (args[0] === "ls-tree") {
    if (args.includes("CHANGELOG.md")) {
      stdout = "100644 blob " + "c".repeat(40) + "\tCHANGELOG.md\0";
    }
  } else {
    throw new Error("Unexpected Git command: " + JSON.stringify(args));
  }
  return { status: 0, stdout, stderr: "" };
};
childProcess.spawnSync = (file, args) => respond(file, args);
childProcess.execFileSync = (file, args) => {
  const result = respond(file, args);
  if (result.status !== 0) {
    throw Object.assign(new Error(result.stderr), result);
  }
  return result.stdout;
};
syncBuiltinESMExports();
