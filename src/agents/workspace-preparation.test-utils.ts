import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as workspaceBootstrap from "./workspace-bootstrap-publish.js";
import { holdWorkspacePreparationSnapshot } from "./workspace-preparation-queue.test-support.js";
import { WorkspaceAliasRepointedError } from "./workspace-state-identity.js";
import {
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
} from "./workspace-state-store.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  ensureAgentWorkspace,
  seedWorkspaceBootstrap,
  WORKSPACE_VANISHED_ERROR_CODE,
} from "./workspace.js";

export function registerWorkspacePreparationTests({
  getFixture,
  expectBootstrapSeeded,
  expectCompletedWithoutBootstrap,
  expectPathMissing,
}: {
  getFixture: () => { state: OpenClawTestState; tempDir: string };
  expectBootstrapSeeded: (dir: string) => Promise<void>;
  expectCompletedWithoutBootstrap: (dir: string) => Promise<void>;
  expectPathMissing: (filePath: string) => Promise<void>;
}) {
  describe("workspace preparation ownership", () => {
    it("does not mistake the shipped template for user content after other workspace files disappear", async () => {
      const { tempDir } = getFixture();
      const historicalAgents = await fs.readFile(
        new URL("../../test/fixtures/agents-template-v2026.9.9.md", import.meta.url),
        "utf8",
      );
      await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), historicalAgents);
      await replaceWorkspaceAttestation({
        workspaceDir: tempDir,
        attestedAtMs: Date.now(),
        generatedHashes: new Map(),
      });

      await expect(
        ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
      ).rejects.toMatchObject({ code: WORKSPACE_VANISHED_ERROR_CODE });
      await expectPathMissing(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
      expect(await fs.readFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "utf8")).toBe(
        historicalAgents,
      );
    });

    it("keeps each queued caller's options and result while another workspace finishes", async ({
      signal,
    }) => {
      const { state, tempDir } = getFixture();
      const alias = `${tempDir}${path.sep}.`;
      const held = holdWorkspacePreparationSnapshot([tempDir, alias]);
      const skipOptionalBootstrapFiles = [DEFAULT_IDENTITY_FILENAME];
      const identity = "# Identity\n- **Name:** Queued\n";
      const templates = { [DEFAULT_IDENTITY_FILENAME]: identity };
      const first = held.run(() =>
        ensureAgentWorkspace({
          dir: tempDir,
          ensureBootstrapFiles: true,
          skipOptionalBootstrapFiles,
        }),
      );
      try {
        await held.ready(first, signal);
        const second = held.run(() =>
          ensureAgentWorkspace({ dir: alias, ensureBootstrapFiles: true, templates }),
        );
        const third = held.run(() =>
          ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false }),
        );
        skipOptionalBootstrapFiles.length = 0;
        templates[DEFAULT_IDENTITY_FILENAME] = "Unapproved later mutation\n";
        held.expectQueued();

        const independent = state.path("independent-workspace");
        await withinTest(
          held.run(() => ensureAgentWorkspace({ dir: independent, ensureBootstrapFiles: true })),
          signal,
        );
        await expectBootstrapSeeded(independent);
        held.expectQueued();
        held.release();

        await expect(first).resolves.toMatchObject({
          identityPathCreated: false,
          bootstrapPending: true,
        });
        await expect(second).resolves.toMatchObject({
          identityPathCreated: true,
          bootstrapPending: false,
        });
        await expect(third).resolves.toEqual({ dir: tempDir, bootstrapPending: false });
        expect(await fs.readFile(path.join(tempDir, DEFAULT_IDENTITY_FILENAME), "utf8")).toBe(
          identity,
        );
        await expectCompletedWithoutBootstrap(tempDir);
      } finally {
        await held.dispose();
      }
    });

    it("preserves healthy followers after failure and queued authority revocation", async ({
      signal,
    }) => {
      const { state } = getFixture();
      for (const outcome of ["failed-leader", "retired-waiter"] as const) {
        const dir = state.path(outcome);
        const held = holdWorkspacePreparationSnapshot([dir]);
        const refusal = new Error(outcome);
        let current = true;
        const first = held.run(() => ensureAgentWorkspace({ dir }));
        try {
          await held.ready(first, signal);
          const denied =
            outcome === "retired-waiter"
              ? held.run(() =>
                  ensureAgentWorkspace({
                    dir,
                    purpose: "Revoked instructions must not appear",
                    guard: {
                      assertHost: () => {
                        if (!current) {
                          throw refusal;
                        }
                      },
                    },
                  }),
                )
              : first;
          const follower = held.run(() => ensureAgentWorkspace({ dir, purpose: "Healthy owner" }));
          current = false;
          held.expectQueued();
          held.release(outcome === "failed-leader" ? refusal : undefined);
          await expect(denied).rejects.toBe(refusal);
          if (outcome === "retired-waiter") {
            await expect(first).resolves.toEqual({ dir, bootstrapPending: false });
          }
          await expect(follower).resolves.toEqual({ dir, bootstrapPending: false });
          const instructions = await fs.readFile(path.join(dir, DEFAULT_AGENTS_FILENAME), "utf8");
          expect(instructions).toContain("Healthy owner");
          expect(instructions).not.toContain("Revoked instructions");
        } finally {
          await held.dispose();
        }
      }
    });

    it("finishes consented seeding before preparation without borrowing its bytes or database options", async ({
      signal,
    }) => {
      const { state, tempDir } = getFixture();
      await ensureAgentWorkspace({ dir: tempDir, purpose: "Synthetic owner" });
      const held = holdWorkspacePreparationSnapshot([tempDir]);
      const content = Buffer.from("# Consented bootstrap\n");
      const statePath = state.path("consented-state.sqlite");
      const redirectedPath = state.path("later-state.sqlite");
      const stateOptions = { path: statePath };
      const seededAt = 1_000;
      const first = held.run(() =>
        seedWorkspaceBootstrap({ dir: tempDir, content, stateOptions, nowMs: seededAt }),
      );
      try {
        await held.ready(first, signal);
        const follower = held.run(() =>
          ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
        );
        content.fill(0);
        stateOptions.path = redirectedPath;
        held.expectQueued();
        held.release();
        await expect(first).resolves.toBe("seeded");
        await expect(follower).resolves.toMatchObject({ bootstrapPending: true });
        expect(await fs.readFile(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME), "utf8")).toBe(
          "# Consented bootstrap\n",
        );
        expect(
          (await readWorkspaceStateSnapshot(tempDir, { path: statePath })).setup.bootstrapSeededAt,
        ).toBe(new Date(seededAt).toISOString());
        await expectPathMissing(redirectedPath);
      } finally {
        await held.dispose();
      }
    });

    it("lets a queued seed observe setup completed by preparation", async ({ signal }) => {
      const { tempDir } = getFixture();
      const held = holdWorkspacePreparationSnapshot([tempDir]);
      const first = held.run(() =>
        ensureAgentWorkspace({
          dir: tempDir,
          ensureBootstrapFiles: true,
          templates: { [DEFAULT_IDENTITY_FILENAME]: "# Identity\n- **Name:** Configured\n" },
        }),
      );
      try {
        await held.ready(first, signal);
        const follower = held.run(() =>
          seedWorkspaceBootstrap({ dir: tempDir, content: Buffer.from("Do not reseed\n") }),
        );
        held.expectQueued();
        held.release();
        await expect(first).resolves.toMatchObject({ bootstrapPending: false });
        await expect(follower).resolves.toBe("consumed");
        await expectCompletedWithoutBootstrap(tempDir);
      } finally {
        await held.dispose();
      }
    });

    it("rejects aliases and roots replaced while their callers wait", async ({ signal }) => {
      const { state } = getFixture();
      const createdDir = state.path("created-directory");
      const displacedDir = state.path("displaced-directory");
      const publish = workspaceBootstrap.publishAgentInstructions;
      const replaceCreatedRoot = vi
        .spyOn(workspaceBootstrap, "publishAgentInstructions")
        .mockImplementationOnce(async (...args) => {
          await publish(...args);
          await fs.rename(createdDir, displacedDir);
          await fs.mkdir(createdDir);
        });
      try {
        await expect(
          ensureAgentWorkspace({ dir: createdDir, ensureBootstrapFiles: true }),
        ).rejects.toThrow("Workspace filesystem changed");
        expect(await fs.readdir(createdDir)).toEqual([]);
        await expect(
          fs.access(path.join(displacedDir, DEFAULT_AGENTS_FILENAME)),
        ).resolves.toBeUndefined();
      } finally {
        replaceCreatedRoot.mockRestore();
      }

      for (const replacement of ["alias", "root"] as const) {
        const dir = state.path(`identity-${replacement}`);
        const alias = state.path(`queued-${replacement}-alias`);
        const other = state.path(`replacement-${replacement}-workspace`);
        await fs.mkdir(dir);
        await fs.mkdir(other);
        await fs.symlink(dir, alias, process.platform === "win32" ? "junction" : "dir");
        const followerDir = replacement === "alias" ? alias : dir;
        const held = holdWorkspacePreparationSnapshot([dir, followerDir]);
        const first = held.run(() => ensureAgentWorkspace({ dir }));
        try {
          await held.ready(first, signal);
          const follower = held.run(() =>
            ensureAgentWorkspace({ dir: followerDir, purpose: "Forbidden replacement write" }),
          );
          held.expectQueued();
          if (replacement === "alias") {
            await fs.unlink(alias);
            await fs.symlink(other, alias, process.platform === "win32" ? "junction" : "dir");
          } else {
            await fs.rename(dir, state.path("original-workspace"));
            await fs.mkdir(dir);
          }
          held.release();
          if (replacement === "alias") {
            await expect(first).resolves.toEqual({ dir, bootstrapPending: false });
            await expect(follower).rejects.toBeInstanceOf(WorkspaceAliasRepointedError);
          } else {
            await expect(first).rejects.toThrow("Workspace filesystem changed");
            await expect(follower).rejects.toThrow("Workspace filesystem changed");
          }
          expect(await fs.readdir(replacement === "alias" ? other : dir)).toEqual([]);
        } finally {
          await held.dispose();
        }
      }
    });

    it("joins first directory and alias creation without inheriting the creator's result", async ({
      signal,
    }) => {
      const { state } = getFixture();
      for (const kind of ["missing-directory", "dangling-alias"] as const) {
        const dir = state.path(`first-created-${kind}`);
        const alias = state.path(`first-created-alias-${kind}`);
        if (kind === "dangling-alias") {
          await fs.symlink(dir, alias, process.platform === "win32" ? "junction" : "dir");
        }
        const followerDir = kind === "dangling-alias" ? alias : `${dir}${path.sep}.`;
        const held = holdWorkspacePreparationSnapshot([dir, followerDir]);
        const first = held.run(() => ensureAgentWorkspace({ dir, ensureBootstrapFiles: true }));
        try {
          await held.ready(first, signal);
          const follower = held.run(() =>
            ensureAgentWorkspace({ dir: followerDir, ensureBootstrapFiles: true }),
          );
          held.expectQueued();
          held.release();
          await expect(first).resolves.toMatchObject({
            identityPathCreated: true,
            bootstrapPending: true,
          });
          await expect(follower).resolves.toMatchObject({
            identityPathCreated: false,
            bootstrapPending: true,
          });
          expect(await fs.realpath(followerDir)).toBe(await fs.realpath(dir));
          await expectBootstrapSeeded(dir);
        } finally {
          await held.dispose();
        }
      }
    });
  });
}
