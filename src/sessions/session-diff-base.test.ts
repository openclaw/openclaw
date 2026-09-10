import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionDiffBase } from "./session-diff-revisions.js";

type GitOutput = (
  cwd: string,
  args: string[],
  okCodes?: readonly number[],
) => Promise<string | null>;

function createGitOut(responses: Record<string, string | null>) {
  return vi.fn(async (_cwd: string, args: string[]): Promise<string | null> => {
    const key = args.join(" ");
    if (key in responses) {
      return responses[key];
    }
    return null;
  }) as unknown as GitOutput;
}

describe("resolveSessionDiffBase remote-tracking fallback", () => {
  let gitOut: ReturnType<typeof createGitOut>;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses origin/main merge base when origin/HEAD and local main are absent", async () => {
    gitOut = createGitOut({
      "symbolic-ref --short refs/remotes/origin/HEAD": null,
      "rev-parse --verify --quiet main": null,
      "rev-parse --verify --quiet master": null,
      "rev-parse --verify --quiet origin/main": "abc123\n",
      "merge-base origin/main HEAD": "merge001\n",
    });

    const result = await resolveSessionDiffBase({
      branch: "feature/x",
      gitOut,
      root: "/repo",
    });

    expect(result).toEqual({ base: "merge001", baseRef: "origin/main" });
  });

  it("uses origin/master when origin/main is absent", async () => {
    gitOut = createGitOut({
      "symbolic-ref --short refs/remotes/origin/HEAD": null,
      "rev-parse --verify --quiet main": null,
      "rev-parse --verify --quiet master": null,
      "rev-parse --verify --quiet origin/main": null,
      "rev-parse --verify --quiet origin/master": "def456\n",
      "merge-base origin/master HEAD": "merge002\n",
    });

    const result = await resolveSessionDiffBase({
      branch: "feature/y",
      gitOut,
      root: "/repo",
    });

    expect(result).toEqual({ base: "merge002", baseRef: "origin/master" });
  });

  it("falls back to HEAD when no remote-tracking default exists", async () => {
    gitOut = createGitOut({
      "symbolic-ref --short refs/remotes/origin/HEAD": null,
      "rev-parse --verify --quiet main": null,
      "rev-parse --verify --quiet master": null,
      "rev-parse --verify --quiet origin/main": null,
      "rev-parse --verify --quiet origin/master": null,
    });

    const result = await resolveSessionDiffBase({
      branch: "feature/z",
      gitOut,
      root: "/repo",
    });

    expect(result).toEqual({ base: "HEAD", baseRef: "HEAD" });
  });

  it("prefers origin/HEAD discovery when available", async () => {
    gitOut = createGitOut({
      "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main\n",
      "merge-base origin/main HEAD": "merge003\n",
    });

    const result = await resolveSessionDiffBase({
      branch: "feature/w",
      gitOut,
      root: "/repo",
    });

    expect(result).toEqual({ base: "merge003", baseRef: "main" });
  });
});
