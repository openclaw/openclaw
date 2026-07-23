// Git push preflight tests cover local-only checks before publishing branches.
import { describe, expect, it } from "vitest";
import { evaluateGitPushPreflight } from "../../scripts/git-push-preflight.mjs";

type GitResult = {
  ok?: boolean;
  stdout?: string;
  stderr?: string;
};

function createGit(overrides: Record<string, GitResult>) {
  const calls: string[] = [];
  const defaults: Record<string, GitResult> = {
    "rev-parse --is-inside-work-tree": { stdout: "true\n" },
    "symbolic-ref --quiet --short HEAD": { stdout: "codex/safe-topic\n" },
    "config --get branch.codex/safe-topic.pushRemote": { ok: false },
    "config --get branch.codex/safe-topic.remote": { stdout: "origin\n" },
    "config --get remote.pushDefault": { stdout: "ForkRemote\n" },
    "remote get-url --push ForkRemote": {
      stdout: "https://github.com/contributor/openclaw.git\n",
    },
    "config --get push.default": { stdout: "current\n" },
    "config --get push.autoSetupRemote": { stdout: "true\n" },
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": { stdout: "origin/main\n" },
  };

  const git = (args: string[]) => {
    const key = args.join(" ");
    calls.push(key);
    const result = overrides[key] ?? defaults[key];
    if (result) {
      return {
        ok: result.ok ?? true,
        status: result.ok === false ? 1 : 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    }
    return { ok: true, status: 0, stdout: "", stderr: "" };
  };

  return { git, calls };
}

describe("evaluateGitPushPreflight", () => {
  const forbiddenPaths = ["youtube-v1/local-output", "music-creator-v1/state/key.pem"];

  it("passes a clean codex branch that pushes to the fork", () => {
    const { git } = createGit({});

    const result = evaluateGitPushPreflight({ git, forbiddenPaths });

    expect(result.ok).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toEqual(["origin_tracking_branch"]);
    expect(result.facts.expectedPushRemote).toBe("ForkRemote");
    expect(result.facts.effectivePushRemote).toBe("ForkRemote");
  });

  it("lets an explicit expected push remote override remote.pushDefault", () => {
    const { git } = createGit({
      "config --get remote.pushDefault": { stdout: "ForkRemote\n" },
      "config --get branch.codex/safe-topic.pushRemote": { stdout: "ReleaseFork\n" },
      "remote get-url --push ReleaseFork": {
        stdout: "https://github.com/release/openclaw.git\n",
      },
    });

    const result = evaluateGitPushPreflight({
      git,
      forbiddenPaths,
      expectedPushRemote: "ReleaseFork",
    });

    expect(result.ok).toBe(true);
    expect(result.facts.expectedPushRemote).toBe("ReleaseFork");
    expect(result.facts.effectivePushRemote).toBe("ReleaseFork");
  });

  it("lets OPENCLAW_PUSH_REMOTE override remote.pushDefault", () => {
    const { git } = createGit({
      "config --get remote.pushDefault": { stdout: "ForkRemote\n" },
      "config --get branch.codex/safe-topic.pushRemote": { stdout: "EnvFork\n" },
      "remote get-url --push EnvFork": {
        stdout: "https://github.com/envfork/openclaw.git\n",
      },
    });

    const result = evaluateGitPushPreflight({
      git,
      forbiddenPaths,
      env: { OPENCLAW_PUSH_REMOTE: "EnvFork" },
    });

    expect(result.ok).toBe(true);
    expect(result.facts.expectedPushRemote).toBe("EnvFork");
    expect(result.facts.effectivePushRemote).toBe("EnvFork");
  });

  it("fails protected branches before push", () => {
    const { git } = createGit({
      "symbolic-ref --quiet --short HEAD": { stdout: "main\n" },
      "config --get branch.main.pushRemote": { ok: false },
      "config --get branch.main.remote": { stdout: "origin\n" },
    });

    const result = evaluateGitPushPreflight({ git, forbiddenPaths });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "protected_branch")).toBe(true);
  });

  it("fails when effective push remote targets upstream origin", () => {
    const { git } = createGit({
      "config --get remote.pushDefault": { ok: false },
      "remote get-url --push origin": { stdout: "https://github.com/openclaw/openclaw.git\n" },
    });

    const result = evaluateGitPushPreflight({ git, forbiddenPaths });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("origin_push_remote");
    expect(result.issues.map((issue) => issue.code)).toContain("upstream_push_url");
  });

  it("redacts credential-like remote URL userinfo in JSON-safe facts and messages", () => {
    const { git } = createGit({
      "remote get-url --push ForkRemote": {
        stdout: "https://ghp_exampletoken@github.com/openclaw/openclaw.git\n",
      },
    });

    const result = evaluateGitPushPreflight({ git, forbiddenPaths });

    expect(result.ok).toBe(false);
    expect(result.facts.effectivePushRemoteUrl).toBe(
      "https://redacted@github.com/openclaw/openclaw.git",
    );
    expect(JSON.stringify(result)).not.toContain("ghp_exampletoken");
  });

  it("fails when push.default would use unsafe implicit behavior", () => {
    const { git } = createGit({
      "config --get push.default": { stdout: "simple\n" },
    });

    const result = evaluateGitPushPreflight({ git, forbiddenPaths });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "unexpected_push_default")).toBe(true);
  });

  it("fails when unpublished history contains forbidden generated paths", () => {
    const { git } = createGit({
      "rev-list --objects HEAD --not --remotes -- youtube-v1/local-output": {
        stdout: "abc123 youtube-v1/local-output/youtube-oauth-token.json\n",
      },
    });

    const result = evaluateGitPushPreflight({ git, forbiddenPaths });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "forbidden_unpublished_history")).toBe(
      true,
    );
  });

  it("fails when a forbidden path is already tracked", () => {
    const { git } = createGit({
      "ls-files -- music-creator-v1/state/key.pem": {
        stdout: "music-creator-v1/state/key.pem\n",
      },
    });

    const result = evaluateGitPushPreflight({ git, forbiddenPaths });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "forbidden_tracked_path")).toBe(true);
  });

  it("adds repeatable local forbidden paths from git config", () => {
    const { git } = createGit({
      "config --get-all openclaw.pushPreflight.forbiddenPath": {
        stdout: "local-only/secrets\nlocal-only/private.pem\n",
      },
      "rev-list --objects HEAD --not --remotes -- local-only/private.pem": {
        stdout: "abc123 local-only/private.pem\n",
      },
    });

    const result = evaluateGitPushPreflight({ git, forbiddenPaths });

    expect(result.ok).toBe(false);
    expect(result.facts.forbiddenPaths).toContain("local-only/secrets");
    expect(result.facts.forbiddenPaths).toContain("local-only/private.pem");
    expect(result.issues.some((issue) => issue.code === "forbidden_unpublished_history")).toBe(
      true,
    );
  });
});
