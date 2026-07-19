import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createPiServer } from "../../../openclaw-pi-service/src/api/server.ts";
import { LocalFilesystemArtifactStore } from "../../../openclaw-pi-service/src/artifacts/local-filesystem-artifact-store.ts";
import {
  GitRepositoryRegistry,
  WorktreeManager,
} from "../../../openclaw-pi-service/src/git/worktree-manager.ts";
import { SkillRegistry } from "../../../openclaw-pi-service/src/packages/skill-registry.ts";
import { SqliteExecutionStore } from "../../../openclaw-pi-service/src/storage/sqlite-execution-store.ts";
import { ExecutionWorker } from "../../../openclaw-pi-service/src/workers/execution-worker.ts";
import { ReviewProcessor } from "../../../openclaw-review-service/src/review-service.ts";
import { createReviewServer } from "../../../openclaw-review-service/src/server.ts";
import { SqliteReviewStore } from "../../../openclaw-review-service/src/store.ts";
import { resetTaskFlowRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { BareGitSquashPromotionAdapter } from "./git-squash-promotion.js";
import { LoopbackPiExecutionAdapter, LoopbackReviewAdapter } from "./loopback-platform-services.js";
import { PlatformJobOrchestrator } from "./platform-job-orchestrator.js";
import { TaskFlowPlatformJobStore } from "./task-flow-platform-job-store.js";

const execFileAsync = promisify(execFile);
const token = "local-roundtrip-token-that-is-not-a-secret";
const ids = {
  project: "prj_018f47b2-9a7c-7abc-8def-0123456789ab",
  repository: "git_018f47b2-9a7c-7abc-8def-0123456789ab",
  skill: "skl_018f47b2-9a7c-7abc-8def-0123456789ab",
  principal: "prn_018f47b2-9a7c-7abc-8def-0123456789ab",
} as const;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("platform test server has no TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeIdleConnections();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(() => {
  resetTaskFlowRegistryForTests();
});

describe("local platform service roundtrip", () => {
  it("crosses Core to Pi to Review over HTTP and squash-promotes the approved commit", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-platform-roundtrip-state-" },
      async () => {
        resetTaskFlowRegistryForTests();
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-platform-roundtrip-"));
        const source = path.join(root, "source");
        const bareRepository = path.join(root, "project.git");
        const worktreeRoot = path.join(root, "worktrees");
        const artifactRoot = path.join(root, "artifacts");
        const policyRoot = path.join(root, "policies");
        const piStore = new SqliteExecutionStore(path.join(root, "pi.sqlite"));
        const reviewStore = new SqliteReviewStore(path.join(root, "review.sqlite"));
        let piServer: Server | undefined;
        let reviewServer: Server | undefined;
        let worker: ExecutionWorker | undefined;
        let worktreePath: string | undefined;

        try {
          await fs.mkdir(source);
          await git(source, "init", "-b", "main");
          await fs.writeFile(path.join(source, "fixture.txt"), "base\n", "utf8");
          await git(source, "add", "fixture.txt");
          await git(
            source,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@openclaw.local",
            "commit",
            "-m",
            "fixture baseline",
          );
          const baseCommit = await git(source, "rev-parse", "HEAD");
          await git(root, "clone", "--bare", source, bareRepository);
          await fs.mkdir(policyRoot);

          const skills = new SkillRegistry();
          skills.register({
            id: ids.skill,
            name: "roundtrip-fixture",
            version: "1.0.0",
            async execute(context) {
              await fs.writeFile(
                path.join(context.worktreePath, "roundtrip-result.txt"),
                `${context.executionId}\n`,
                "utf8",
              );
              return {
                summary: "Deterministic local Pi execution completed.",
                checks: [
                  {
                    name: "fixture",
                    status: "passed",
                    output: "roundtrip-result.txt created",
                  },
                ],
              };
            },
          });
          worker = new ExecutionWorker(
            piStore,
            new WorktreeManager(
              worktreeRoot,
              new GitRepositoryRegistry(new Map([[ids.repository, bareRepository]])),
            ),
            skills,
            new LocalFilesystemArtifactStore(artifactRoot),
          );
          piServer = createPiServer(
            {
              host: "127.0.0.1",
              port: 1,
              bearerToken: token,
              workspaceRoot: root,
              databasePath: path.join(root, "pi.sqlite"),
              registryPath: path.join(root, "unused-registry.json"),
              worktreeRoot,
              artifactRoot,
            },
            piStore,
            () => worker!.kick(),
          );
          const piBaseUrl = await listen(piServer);

          let reviewedWorktree: string | undefined;
          const reviewConfig = {
            host: "127.0.0.1" as const,
            port: 1,
            bearerToken: token,
            workspaceRoot: root,
            databasePath: path.join(root, "review.sqlite"),
            worktreeRoot,
            artifactRoot,
            policyRoot,
            cursorModel: "not-used-by-deterministic-adapter",
          };
          const reviewProcessor = new ReviewProcessor(reviewConfig, reviewStore, {
            review: async (request, signal) => {
              signal.throwIfAborted();
              reviewedWorktree = request.worktreePath;
              return {
                decision: "approved",
                findings: [],
                artifact_ids: request.command.artifact_ids,
                summary: "Deterministic local review approved the sealed Pi commit.",
              };
            },
          });
          reviewServer = createReviewServer(reviewConfig, reviewStore, reviewProcessor, () => true);
          const reviewBaseUrl = await listen(reviewServer);

          const stateStore = new TaskFlowPlatformJobStore();
          const result = await new PlatformJobOrchestrator({
            executions: new LoopbackPiExecutionAdapter({
              baseUrl: piBaseUrl,
              bearerToken: token,
              pollIntervalMs: 5,
            }),
            reviews: new LoopbackReviewAdapter({
              baseUrl: reviewBaseUrl,
              bearerToken: token,
              pollIntervalMs: 5,
            }),
            promotions: new BareGitSquashPromotionAdapter(),
            state: stateStore,
          }).run({
            project: {
              schema_version: "1.0.0",
              project_id: ids.project,
              aggregate_version: 1,
              owner_principal_id: ids.principal,
              display_name: "Local platform roundtrip",
              slug: "local-platform-roundtrip",
              project_kind: "application",
              source: { type: "git_repository", git_repository_id: ids.repository },
              deployment_policy: { type: "disabled" },
              policy_ids: [],
              tags: [],
              created_at: "2026-07-18T12:00:00.000Z",
              updated_at: "2026-07-18T12:00:00.000Z",
              git_repository_id: ids.repository,
              head_commit_sha: baseCommit,
              git_object_format: "sha1",
              default_branch: "main",
              status: "active",
              repositoryPath: bareRepository,
            },
            request: {
              schema_version: "1.0.0",
              project_id: ids.project,
              task: "Create the deterministic local roundtrip result.",
              priority: "normal",
            },
            skillIds: [ids.skill],
          });

          expect(result.state.job.status).toBe("completed");
          expect(result.state.execution?.execution_id).toBe(result.state.job.current_execution_id);
          expect(result.state.review?.decision).toBe("approved");
          expect(result.state.promotion).toMatchObject({ strategy: "squash", pushed: false });
          expect(
            piStore
              .eventsAfter(result.state.job.current_execution_id!, 0)
              .map((event) => event.type),
          ).toContain("execution_completed");
          expect(reviewStore.get(result.state.job.current_review_id!)).toMatchObject({
            status: "completed",
          });

          worktreePath = reviewedWorktree;
          expect(worktreePath).toBe(
            path.join(
              worktreeRoot,
              ids.project,
              result.state.job.job_id,
              result.state.execution!.worktree_id,
            ),
          );
          expect(await git(bareRepository, "rev-list", "--count", "main")).toBe("2");
          expect(
            await git(bareRepository, "rev-parse", `${result.state.promotion!.commitSha}^`),
          ).toBe(baseCommit);
          expect(
            await git(bareRepository, "rev-parse", `${result.state.promotion!.commitSha}^{tree}`),
          ).toBe(
            await git(bareRepository, "rev-parse", `${result.state.execution!.commit_sha}^{tree}`),
          );
          expect(
            await git(
              bareRepository,
              "show",
              `${result.state.promotion!.commitSha}:roundtrip-result.txt`,
            ),
          ).toMatch(/^exe_/u);

          const persistedState = stateStore.get(result.flowId)?.state;
          expect(persistedState?.job.status).toBe("completed");
          const persisted = JSON.stringify(persistedState);
          expect(persisted).not.toContain(root);
          expect(persisted).not.toContain(token);
          expect(persisted).not.toContain(piBaseUrl);
          expect(persisted).not.toContain(reviewBaseUrl);
        } finally {
          if (reviewServer) {
            await close(reviewServer);
          }
          if (piServer) {
            await close(piServer);
          }
          if (worker) {
            await worker.idle();
          }
          if (worktreePath) {
            await git(bareRepository, "worktree", "remove", "--force", worktreePath);
            await git(bareRepository, "worktree", "prune");
          }
          reviewStore.close();
          piStore.close();
          resetTaskFlowRegistryForTests();
          await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      },
    );
  });
});
