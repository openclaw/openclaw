import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { useInProcessWorktreeCapacityTransport } from "./capacity.test-support.js";
import { prepareManagedWorktreeTemplate } from "./checkout.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import { createCopyWorktreeBackend } from "./filesystem-backend.test-support.js";
import type { WorktreeFilesystemBackend } from "./filesystem-backend.types.js";
import { git } from "./git-fixture.test-support.js";
import * as preparationTiming from "./preparation-timing.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import { listTemplatesAsync, readTemplateAsync } from "./template-registry-async.js";

// mock-isolation: Real Git and template ownership use a portable independent-copy backend.
vi.mock("./filesystem-backend.js", () => ({ detectWorktreeFilesystemBackend: vi.fn() }));

const preparationEvent = vi.hoisted(() => vi.fn());
// mock-isolation: Observe the completed outcome instead of the asynchronous diagnostics queue.
vi.mock("../../infra/diagnostic-events.js", async (original) => ({
  ...(await original<typeof import("../../infra/diagnostic-events.js")>()),
  createQueuedDiagnosticPhaseEmitter: () => preparationEvent,
}));

describe("managed template rejection diagnostics", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;
  let backend: WorktreeFilesystemBackend;
  beforeEach(async () => {
    useInProcessWorktreeCapacityTransport();
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_ATTR_NOSYSTEM", "1");
    const root = tempDirs.make("openclaw-template-diagnostics-");
    repo = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    now = Date.now();
    backend = createCopyWorktreeBackend();
    vi.mocked(detectWorktreeFilesystemBackend).mockReset().mockResolvedValue(backend);
    service = new ManagedWorktreeService({ env, getConfig: () => ({}) });
  });

  it.each(["ignored", "HEAD", "worktree-config", "sparse", "source-only-sparse"] as const)(
    "rebuilds a template with %s contamination before creating another checkout",
    async (change) => {
      const sparse = change === "sparse" || change === "source-only-sparse";
      const provisionIgnoredFiles = change !== "source-only-sparse";
      await fs.writeFile(path.join(repo, ".gitignore"), "ignored-*\n");
      if (sparse) {
        await fs.mkdir(path.join(repo, "included"));
        await fs.writeFile(path.join(repo, "included", "file.txt"), "included\n");
      }
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "ignore template fixture");
      // The older commit has identical files, so HEAD validation cannot be
      // replaced by comparing the tree or accepting a clean inventory alone.
      await git(repo, "commit", "--allow-empty", "-m", "new template base");
      if (change === "worktree-config" || sparse) {
        await git(repo, "config", "extensions.worktreeConfig", "true");
      }
      await service.create({
        repoRoot: repo,
        name: "seed",
        baseRef: "HEAD",
        provisionIgnoredFiles,
      });
      const original = (await listTemplatesAsync(env))[0];
      assert(original);
      const unusualName = process.platform === "win32" ? "é space.txt" : "é space\nname.txt";
      if (change === "HEAD") {
        await git(original.path, "checkout", "--detach", "HEAD~1");
      } else if (change === "worktree-config") {
        await git(original.path, "config", "--worktree", "core.autocrlf", "true");
      } else if (sparse) {
        await git(original.path, "sparse-checkout", "set", "--cone", "missing-directory");
        await expect(fs.access(path.join(original.path, "included"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        await fs.writeFile(
          path.join(original.path, `ignored-${unusualName}`),
          "template contamination\n",
        );
      }

      const created = await service.create({
        repoRoot: repo,
        name: "replacement",
        baseRef: "HEAD",
        provisionIgnoredFiles,
      });

      const replacement = await readTemplateAsync(env, original.cacheKey);
      assert(replacement);
      expect(replacement.id).not.toBe(original.id);
      await fs.access(original.path);
      expect((await fs.readdir(created.path)).toSorted()).toEqual([
        ".git",
        ".gitignore",
        "README.md",
        ...(sparse ? ["included"] : []),
      ]);
      expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
      expect(await git(created.path, "rev-parse", "HEAD")).toBe(original.sourceCommit);
      expect(
        await git(created.path, "status", "--porcelain", "--untracked-files=all", "--ignored"),
      ).toBe("");
      expect(preparationEvent.mock.lastCall?.[0].details).toMatchObject({
        template: "cold",
        "template.refreshRejectReason": "validation-failed",
        "template.validationFailure":
          change === "HEAD" ? "head-mismatch" : change === "ignored" ? "dirty" : "checkout-policy",
      });
    },
  );

  it.each(["attributes", "policy", "diff-exit", "diff-timeout", "status", "malformed", "missing"])(
    "reports the managed cold-selection cause (%s) in the completed outcome",
    async (cause) => {
      await git(repo, "config", "extensions.worktreeConfig", "true");
      await service.create({ repoRoot: repo, name: "seed", baseRef: "HEAD" });
      const original = (await listTemplatesAsync(env))[0]!;
      await fs.writeFile(path.join(repo, "README.md"), "advanced\n");
      if (cause === "attributes") {
        await fs.writeFile(path.join(repo, ".gitattributes"), "*.md text eol=crlf\n");
      }
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "advance");
      const base = await git(repo, "rev-parse", "HEAD");
      const destination = path.join(path.dirname(repo), "diagnostic-target");
      await git(repo, "worktree", "add", "--detach", "--no-checkout", destination, base);
      if (cause === "policy") {
        await git(destination, "config", "--worktree", "core.autocrlf", "true");
      }
      if (cause === "missing") {
        await fs.rm(original.path, { recursive: true });
      }
      const execute = gitExec.executeGitCommand;
      let failedProbes = 0;
      using _ = vi.spyOn(gitExec, "executeGitCommand").mockImplementation((cwd, args, options) => {
        if (
          cwd === original.path &&
          ((cause.startsWith("diff-") && args.includes("diff-tree")) ||
            (["status", "malformed"].includes(cause) && args.includes("status")))
        ) {
          failedProbes++;
          return Promise.resolve({
            ...createCommandResult({
              code: cause === "malformed" ? 0 : 128,
              termination: cause === "diff-timeout" ? "timeout" : "exit",
              stdout: cause === "malformed" ? `# branch.oid ${original.sourceCommit}` : "",
              stderr: "synthetic private probe detail",
            }),
            timeoutMs: 0,
          });
        }
        return execute(cwd, args, options);
      });
      const pending = preparationTiming.withWorktreePreparationTiming("managed", () =>
        prepareManagedWorktreeTemplate({
          env,
          now: () => now,
          enabled: true,
          useWarmPool: false,
          repoRoot: repo,
          commonDir: path.join(repo, ".git"),
          worktreeRoot: original.worktreeRoot,
          destination,
          base,
          requireSpace: async () => {},
          commitGuard: () => {},
        }),
      );
      const prepared = cause === "policy" ? undefined : await pending;
      if (cause === "policy") {
        await expect(pending).rejects.toThrow("Template and target checkout configurations differ");
      }
      try {
        if (prepared) {
          assert(!prepared.warm);
          expect(await git(prepared.record.path, "rev-parse", "HEAD")).toBe(base);
          expect(await fs.readFile(path.join(prepared.record.path, "README.md"), "utf8")).toBe(
            cause === "attributes" ? "advanced\r\n" : "advanced\n",
          );
        }
        expect(backend.createTemplate).toHaveBeenCalledTimes(2);
        const details = preparationEvent.mock.lastCall?.[0].details;
        expect(details).toMatchObject({
          template: "cold",
          "template.reason": cause === "policy" ? "template-create" : "ready",
          "template.missReason": "commit-changed",
          "template.refreshRejectReason":
            cause === "attributes"
              ? "attributes-changed"
              : cause === "policy"
                ? "checkout-policy-mismatch"
                : cause.startsWith("diff-")
                  ? "diff-probe-failed"
                  : cause === "missing"
                    ? "template-missing"
                    : "validation-failed",
          ...(["status", "malformed"].includes(cause)
            ? {
                "template.validationFailure":
                  cause === "status" ? "status-probe" : "status-malformed",
              }
            : {}),
          ...(cause.startsWith("diff-") || cause === "status"
            ? {
                "template.refreshErrorClass": cause === "diff-timeout" ? "timeout" : "exit-nonzero",
              }
            : {}),
        });
        expect(JSON.stringify(details)).not.toContain("synthetic private probe detail");
        expect(failedProbes).toBe(
          cause.startsWith("diff-") || ["status", "malformed"].includes(cause) ? 1 : 0,
        );
      } finally {
        if (prepared && !prepared.warm) {
          await prepared.record.release();
        }
      }
    },
  );
});
