import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

describe("Control UI controller guard", () => {
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
    const runLint = (args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          path.resolve("scripts/tsx.mjs"),
          path.resolve("scripts/run-lint.mts"),
          ...args,
        ],
        {
          cwd: root,
          env: { ...createNestedGitEnv(), CHECKOUT_BASE_SHA: "HEAD" },
          encoding: "utf8",
        },
      );
    fs.writeFileSync(source, "class NewController {}\n");
    git(root, ["add", "."]);
    fs.writeFileSync(source, "export {};\n");
    const staged = runLint(["--staged", "--only=extensions"]);
    expect(staged.error).toBeUndefined();
    expect(staged.status, staged.stderr).toBe(1);
    expect(staged.stderr).toContain("ui/src/new.ts");
    git(root, ["commit", "-m", "new controller"]);
    fs.writeFileSync(source, "class NewController {}\n");
    const based = runLint(["--base", "baseline", "--only=extensions"]);
    expect(based.error).toBeUndefined();
    expect(based.status, based.stderr).toBe(1);
    expect(based.stderr).toContain("ui/src/new.ts");
  });
});
