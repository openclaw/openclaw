import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { requireGit } from "../agents/worktrees/git.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { importCarriedWork } from "./session-workspace-carry.js";

const commit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit"];

it.each(["a .git file", "alternates"] as const)(
  "refuses a host checkout whose Git data reaches another host repository through %s",
  async (route) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const project = path.join(state.root, "project");
      await fs.mkdir(project);
      await requireGit(project, ["init", "-q", "-b", "main"]);
      await fs.writeFile(path.join(project, "README.md"), "project\n");
      await requireGit(project, ["add", "."]);
      await requireGit(project, [...commit, "-q", "-m", "Project base"]);
      // A private repository elsewhere on the host that shares the project's history.
      const victim = path.join(state.root, "victim");
      await requireGit(state.root, ["clone", "-q", project, victim]);
      await fs.writeFile(path.join(victim, "secret.txt"), "host secret\n");
      await requireGit(victim, ["add", "."]);
      await requireGit(victim, [...commit, "-q", "-m", "Private victim commit"]);
      const secret = await requireGit(victim, ["rev-parse", "HEAD"]);
      const victimObjects = await requireGit(victim, ["count-objects"]);

      const checkout = path.join(state.workspaceDir, "checkout");
      if (route === "a .git file") {
        await fs.mkdir(checkout, { recursive: true });
        await fs.writeFile(path.join(checkout, ".git"), `gitdir: ${path.join(victim, ".git")}\n`);
        await requireGit(checkout, ["reset", "-q", "--hard"]);
      } else {
        await requireGit(state.workspaceDir, ["clone", "-q", "--shared", victim, checkout]);
      }
      expect(await requireGit(checkout, ["rev-parse", "HEAD"])).toBe(secret);

      await expect(
        importCarriedWork({
          source: { kind: "host", workspaceDir: state.workspaceDir },
          checkout: "checkout",
          projectRoot: project,
          refName: "refs/openclaw/carry/review",
          assertCurrent() {},
        }),
      ).rejects.toThrow("outside this conversation's workspace");
      await expect(requireGit(project, ["cat-file", "-e", `${secret}^{commit}`])).rejects.toThrow();
      expect(await requireGit(victim, ["count-objects"])).toBe(victimObjects);
    });
  },
);
