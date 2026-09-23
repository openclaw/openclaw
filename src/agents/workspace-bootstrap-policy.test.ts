import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createWorkspaceBootstrapFilePolicy } from "./workspace-bootstrap-policy.js";

function policyFor(config: OpenClawConfig) {
  return createWorkspaceBootstrapFilePolicy({ workspaceDir: "/workspace", config });
}

describe("workspace bootstrap file policy", () => {
  it.runIf(process.platform !== "win32")(
    "keeps literal POSIX backslashes distinct from directories",
    () => {
      const policy = policyFor({
        hooks: {
          internal: {
            entries: { "bootstrap-extra-files": { paths: ["team\\notes/AGENTS.md"] } },
          },
        },
      });
      expect(policy.canRead("team/notes/AGENTS.md")).toBe(false);
    },
  );

  it("permits glob discovery without granting unrelated bytes or additional owner writes", () => {
    const policy = policyFor({
      hooks: {
        internal: {
          entries: {
            "bootstrap-extra-files": {
              paths: [
                " ./team/{core,api}/**/AGENTS.md ",
                "team[1]/SOUL.md",
                "../private/AGENTS.md",
              ],
              patterns: ["private/AGENTS.md"],
            },
          },
        },
      },
    });
    expect(policy.canList("team")).toBe(true);
    expect(policy.canList("team/core")).toBe(true);
    expect(policy.canList("team/api/nested")).toBe(true);
    expect(policy.canRead("team/core/AGENTS.md")).toBe(true);
    expect(policy.canRead("team/api/nested/AGENTS.md")).toBe(true);
    expect(policy.canRead("team[1]/SOUL.md")).toBe(true);
    for (const file of [
      "team/core/secret.txt",
      "team/other/AGENTS.md",
      "private/AGENTS.md",
      "../private/AGENTS.md",
      "/workspace/AGENTS.md",
    ]) {
      expect(policy.canRead(file), file).toBe(false);
    }
    for (const directory of [".", "private", "team/other", "../private"]) {
      expect(policy.canList(directory), directory).toBe(false);
    }
    for (const file of ["team/core/AGENTS.md", "MEMORY.md", "BOOTSTRAP.md"]) {
      expect(policy.canWrite(file), file).toBe(false);
    }
    expect(policy.canWrite("AGENTS.md")).toBe(true);
  });

  it.each(["patterns", "files"])(
    "uses the existing %s config key and restricts wildcard reads to bootstrap names",
    (key) => {
      const policy = policyFor({
        hooks: {
          internal: {
            entries: {
              "bootstrap-extra-files": { paths: [" "], [key]: ["**/*"] },
            },
          },
        },
      });
      expect(policy.canList(".")).toBe(true);
      expect(policy.canList("team/nested")).toBe(true);
      expect(policy.canRead("team/nested/AGENTS.md")).toBe(true);
      expect(policy.canRead("team/nested/secret.txt")).toBe(false);
      expect(policy.canRead("team/../private/AGENTS.md")).toBe(false);
    },
  );

  it.each(["all-hooks", "extra-files"])(
    "does not grant extra access when %s is disabled",
    (disabled) => {
      const policy = policyFor({
        hooks: {
          internal: {
            enabled: disabled !== "all-hooks",
            entries: {
              "bootstrap-extra-files": {
                enabled: disabled !== "extra-files",
                paths: ["**/AGENTS.md"],
              },
            },
          },
        },
      });
      expect(policy.canRead("AGENTS.md")).toBe(true);
      expect(policy.canRead("team/AGENTS.md")).toBe(false);
      expect(policy.canList(".")).toBe(false);
    },
  );
});
