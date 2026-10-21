import { execFileSync } from "node:child_process";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

export function initRepo(root: string, objectFormat?: "sha1" | "sha256"): void {
  const args = ["init", "-q", "-b", "main"];
  if (objectFormat) {
    args.push(`--object-format=${objectFormat}`);
  }
  git(root, ...args);
  git(root, "config", "user.email", "test@openclaw.test");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
}

export const fixedStoreConfig = () =>
  ({
    session: { store: "/tmp/shared.sqlite", scope: "global" },
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: "ops" } },
      entries: { ops: {}, research: {} },
    },
  }) as const;
