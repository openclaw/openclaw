import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as localWorkspace from "../../agents/sandbox/local-workspace.js";
import { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { useManagedWorktreeTestRepository } from "../../agents/worktrees/service.test-support.js";
import { stageSandboxMedia } from "../../auto-reply/reply/stage-sandbox-media.js";
import { createSandboxMediaContexts } from "../../auto-reply/stage-sandbox-media.test-harness.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readLocalWorkspaceProjection } from "../../gateway/worker-environments/local-workspace-store.test-support.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import * as fsSafe from "../../infra/fs-safe.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const initializeRepository = useManagedWorktreeTestRepository();
afterEach(() => vi.restoreAllMocks());

it.for(["staged", "read-failed", "aborted", "retired"] as const)(
  "settles managed attachment ownership after %s source I/O",
  async (outcome, { signal }) => {
    await withOpenClawTestState({ label: "staging-workspace-lifetime" }, async (state) => {
      await loadOrCreateProcessDeviceIdentityAsync();
      const repoRoot = await initializeRepository(state.path("repository"));
      const sessionKey = "agent:main:dashboard:staging-lifetime";
      const cfg = {
        worktreeAcceleration: false,
        agents: {
          entries: { main: { workspace: state.workspaceDir } },
          defaults: {
            skipBootstrap: true,
            sandbox: { mode: "off", backend: "docker", workspaceAccess: "none" },
          },
        },
      } satisfies OpenClawConfig;
      setRuntimeConfigSnapshot(cfg);
      const service = new ManagedWorktreeService({ env: process.env });
      const worktree = await service.create({
        repoRoot,
        name: "staging-lifetime",
        baseRef: "HEAD",
        ownerKind: "session",
        ownerId: sessionKey,
      });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "staging-lifetime-session",
          updatedAt: 1,
          sandbox: "required",
          spawnedCwd: worktree.path,
          worktree: { id: worktree.id, branch: worktree.branch, repoRoot },
        },
      );
      const source = await state.writeText(
        "media/inbound/attachment.txt",
        "ordinary attachment bytes",
      );
      const { ctx, sessionCtx } = createSandboxMediaContexts(source);
      const prepare = vi.spyOn(localWorkspace, "prepareLocalSandboxWorkspace");
      const controller = new AbortController();
      const failure = new Error("attachment source read failed");
      const reading = createDeferred();
      const releaseRead = createDeferred();
      const open = fsSafe.openLocalFileSafely;
      vi.spyOn(fsSafe, "openLocalFileSafely").mockImplementation(async (params) => {
        if (params.filePath === source) {
          reading.resolve();
          await releaseRead.promise;
          if (outcome === "read-failed") {
            throw failure;
          }
        }
        return open(params);
      });
      const pending = stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        agentId: "main",
        sessionKey,
        workspaceDir: worktree.path,
        abortSignal: controller.signal,
      });
      void pending.catch(() => {});
      try {
        await withinTest(
          awaitGateBeforeSettlement(reading.promise, pending, "source read not reached"),
          signal,
        );
        const owner = await prepare.mock.results[0]?.value;
        expect(owner).toBeDefined();
        expect(() => owner!.assertCurrent()).not.toThrow();
        const projection = await readLocalWorkspaceProjection(worktree.id);
        expect(projection).toBeDefined();
        const projectionPath = projection!.projection_path;
        if (outcome === "retired") {
          expect(await service.remove({ id: worktree.id, reason: "manual-delete" })).toMatchObject({
            removed: true,
          });
          await expect(fs.stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
        } else if (outcome === "aborted") {
          controller.abort(failure);
        }
        releaseRead.resolve();
        if (outcome === "aborted") {
          await expect(pending).rejects.toBe(failure);
        } else {
          const result = await pending;
          if (outcome === "staged") {
            expect(result.staged.size).toBe(1);
            expect(
              await fs.readFile(path.join(projectionPath, result.staged.get(0)!), "utf8"),
            ).toBe("ordinary attachment bytes");
          } else {
            expect(result.staged.size).toBe(0);
            expect(ctx.media?.[0]?.path).toBe(source);
          }
        }
        if (outcome !== "staged") {
          await expect(
            fs.stat(path.join(projectionPath, "media", "inbound")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(() => owner!.assertCurrent()).toThrow("Local sandbox workspace authority changed");
      } finally {
        releaseRead.resolve();
        await pending.catch(() => {});
      }
    });
  },
);
