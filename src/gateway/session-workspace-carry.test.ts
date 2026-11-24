import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { requireGit } from "../agents/worktrees/git.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { importCarriedWork, listCarryCheckouts } from "./session-workspace-carry.js";

const commit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit"];

const routes = ["a .git file", "alternates", "symlinked objects and refs", "an unreadable folder"];

it("refuses an unrelated branch even when its clone has the project tip", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const project = path.join(state.root, "project");
    await fs.mkdir(project);
    await requireGit(project, ["init", "-q", "-b", "main"]);
    await requireGit(project, [...commit, "--allow-empty", "-m", "Project base"]);
    const checkout = path.join(state.workspaceDir, "checkout");
    await requireGit(state.workspaceDir, ["clone", "-q", project, checkout]);
    await requireGit(checkout, ["switch", "--orphan", "unrelated"]);
    await requireGit(checkout, [...commit, "--allow-empty", "-m", "Unrelated work"]);

    const refName = "refs/openclaw/carry/review";
    await expect(
      importCarriedWork({
        source: { kind: "host", workspaceDir: state.workspaceDir },
        checkout: "checkout",
        projectRoot: project,
        refName,
        assertCurrent() {},
      }),
    ).rejects.toThrow("shares no history");
    expect(await requireGit(project, ["for-each-ref", "--format=%(refname)", refName])).toBe("");
  });
});

it.each(routes)(
  "refuses and does not list a host checkout whose Git data has %s",
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
      let locked: string | undefined;
      if (route === "a .git file") {
        await fs.mkdir(checkout, { recursive: true });
        await fs.writeFile(path.join(checkout, ".git"), `gitdir: ${path.join(victim, ".git")}\n`);
        await requireGit(checkout, ["reset", "-q", "--hard"]);
      } else if (route === "alternates") {
        await requireGit(state.workspaceDir, ["clone", "-q", "--shared", victim, checkout]);
      } else if (route === "symlinked objects and refs") {
        // A real .git folder in the workspace whose objects and refs live elsewhere.
        const dotGit = path.join(checkout, ".git");
        await fs.mkdir(dotGit, { recursive: true });
        await fs.symlink(path.join(victim, ".git", "objects"), path.join(dotGit, "objects"));
        await fs.symlink(path.join(victim, ".git", "refs"), path.join(dotGit, "refs"));
        await fs.writeFile(path.join(dotGit, "HEAD"), "ref: refs/heads/main\n");
        await requireGit(checkout, ["reset", "-q", "--hard"]);
      } else {
        // Git data that cannot be walked cannot be shown to be the conversation's own.
        await requireGit(state.workspaceDir, ["clone", "-q", victim, checkout]);
        locked = path.join(checkout, ".git", "locked");
        await fs.mkdir(locked, { mode: 0o000 });
      }
      try {
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
        await expect(
          requireGit(project, ["cat-file", "-e", `${secret}^{commit}`]),
        ).rejects.toThrow();
        // The move dialog does not list it, and one such checkout does not break the list.
        expect(
          await listCarryCheckouts({ kind: "host", workspaceDir: state.workspaceDir }),
        ).toEqual([]);
        expect(await requireGit(victim, ["count-objects"])).toBe(victimObjects);
      } finally {
        // The test state is removed next, which needs the folder readable again.
        if (locked) {
          await fs.chmod(locked, 0o755);
        }
      }
    });
  },
);
