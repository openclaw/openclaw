import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-control-ui-controllers.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function git(cwd: string, args: string[]) {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], {
    cwd,
    env: createNestedGitEnv(),
    stdio: "ignore",
  });
}

function fixture(source = "export {};\n") {
  const root = tempDirs.make("openclaw-controller-guard-");
  fs.mkdirSync(path.join(root, "ui/src"), { recursive: true });
  fs.writeFileSync(path.join(root, "ui/src/view.ts"), source);
  for (const args of [["init"], ["add", "."], ["commit", "-m", "base"]]) {
    git(root, args);
  }
  return root;
}

function runLint(root: string, args: string[], checkoutBase = "HEAD") {
  return spawnSync(
    process.execPath,
    ["--import", path.resolve("scripts/tsx.mjs"), path.resolve("scripts/run-lint.mts"), ...args],
    {
      cwd: root,
      env: { ...createNestedGitEnv(), CHECKOUT_BASE_SHA: checkoutBase },
      encoding: "utf8",
    },
  );
}

describe("Control UI controller guard", () => {
  it("rejects new host consumers while existing controllers are still being retired", () => {
    const root = fixture(
      'import type { SolidController } from "./lib/reactive/solid-controller-host.ts";\nclass OldController {}\n',
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const target = path.join(root, "ui/src/new.ts");
    for (const source of [
      'import type { SolidControllerHost } from "./lib/reactive/solid-controller-host.ts";',
      'export { useSolidControllerHost } from "./lib/reactive/solid-controller-host.ts";',
      'const load = () => import("./lib/reactive/solid-controller-host.ts");',
      "const load = () => import(`./lib/reactive/solid-controller-host.ts`);",
      'type Host = import("./lib/reactive/solid-controller-host.ts").SolidControllerHost;',
    ]) {
      fs.writeFileSync(target, source);
      expect(main(root, ["--base", "HEAD"]), source).toBe(1);
    }
    fs.writeFileSync(target, 'const example = "./lib/reactive/solid-controller-host.ts";\n');
    fs.writeFileSync(
      path.join(root, "ui/src/new.test.ts"),
      'import type { SolidControllerHost } from "./lib/reactive/solid-controller-host.ts";',
    );
    expect(main(root, ["--base", "HEAD"])).toBe(0);
  });

  it("allows controller growth until all production controllers are retired", () => {
    const root = fixture("class OldController { hostConnected() {} }\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const target = path.join(root, "ui/src/new.ts");
    fs.writeFileSync(target, "class NewController { hostDisconnected() {} requestUpdate() {} }\n");
    expect(main(root, ["--base", "HEAD"])).toBe(0);

    fs.writeFileSync(path.join(root, "ui/src/view.ts"), "// class OldController {}\n");
    fs.writeFileSync(target, 'const text = "hostConnected requestUpdate";\n');
    fs.writeFileSync(path.join(root, "ui/src/view.test.ts"), "class TestController {}\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "retire production controllers"]);
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    for (const source of [
      "class NewController {}",
      "const host = { hostConnected() {}, hostDisconnected() {}, requestUpdate() {} };",
      "host.requestUpdate();",
    ]) {
      fs.writeFileSync(target, source);
      expect(main(root, ["--base", "HEAD"]), source).toBe(1);
    }
  });

  it("preserves staged and explicit base scope through the full lint entry point", () => {
    const root = fixture();
    git(root, ["tag", "baseline"]);
    const source = path.join(root, "ui/src/new.ts");
    fs.writeFileSync(source, "class NewController {}\n");
    git(root, ["add", "."]);
    fs.writeFileSync(source, "export {};\n");
    const staged = runLint(root, ["--staged", "--only=extensions"]);
    expect(staged.error).toBeUndefined();
    expect(staged.status, staged.stderr).toBe(1);
    expect(staged.stderr).toContain("ui/src/new.ts");
    git(root, ["commit", "-m", "new controller"]);
    fs.writeFileSync(source, "class NewController {}\n");
    const based = runLint(root, ["--base", "baseline", "--only=extensions"]);
    expect(based.error).toBeUndefined();
    expect(based.status, based.stderr).toBe(1);
    expect(based.stderr).toContain("ui/src/new.ts");
  });

  it("uses the prepared base in a shallow candidate and rejects retired controllers", () => {
    const source = fixture();
    const fork = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
    }).trim();
    git(source, ["checkout", "-b", "candidate"]);
    git(source, ["commit", "--allow-empty", "-m", "candidate"]);
    git(source, ["checkout", "-b", "moving-main", fork]);
    git(source, ["rm", "ui/src/view.ts"]);
    git(source, ["commit", "-m", "upstream view removal"]);
    const root = tempDirs.make("openclaw-controller-shallow-");
    git(root, ["clone", "--depth=1", "--branch=candidate", pathToFileURL(source).href, "."]);
    git(root, ["fetch", "--depth=1", "origin", "moving-main:refs/remotes/origin/main", fork]);
    expect(spawnSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: root }).status).not.toBe(
      0,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(root, ["--base", "origin/main"])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain("Could not resolve ratchet merge base");
    expect(main(root, ["--base", fork, "--no-merge-base"])).toBe(0);
    const inferred = runLint(root, ["--only=extensions"], fork);
    expect(inferred.stdout).toContain("Control UI controller guard OK");
    const explicit = runLint(root, ["--base", "origin/main", "--only=extensions"], fork);
    expect(explicit.status).not.toBe(0);
    expect(explicit.stderr).toContain("Could not resolve ratchet merge base");
    fs.writeFileSync(path.join(root, "ui/src/new.ts"), "class NewController {}\n");
    expect(main(root, ["--base", fork, "--no-merge-base"])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toContain("ui/src/new.ts");
  });
});
