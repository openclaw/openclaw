// Install the existing synthetic GitHub transport before loading publication owners.
// oxfmt-ignore
import { publicationCheckpoint as checkpoint } from "./github-publication-actions.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createGitHubPublishTool } from "../agents/tools/github-publish-tool.js";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import { createRequesterPublicationFixture } from "./github-publication-requester.test-support.js";
import {
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createContext as createRequestContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  resolveLocalWorkspaceOwner,
  withLocalWorkspaceProjection,
} from "./worker-environments/local-workspace-projection.js";
import * as workspaceStore from "./worker-environments/local-workspace-store.js";
import { isLocalWorkspaceBaseRefreshRef } from "./worker-environments/workspace-result-inventory.js";
import { workerWorkspaceResultStaging } from "./worker-environments/workspace-result-staging.js";

const mocks = githubPublicationTestMocks();

describe("base refresh through the registered session action", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it("recovers one guest integration, retains saved data and publishes the resolved same draft with base ancestry", async () => {
    const initialWorktree = { ...mocks.findWorktree("session", "unused"), id: randomUUID() };
    mocks.findWorktree.mockImplementation((_kind: string, ownerId: string) => ({
      ...initialWorktree,
      ownerId,
    }));
    const f = await createRequesterPublicationFixture(checkpoint, "local");
    const local = f.local!;
    await fs.writeFile(path.join(local.cwd, ".gitignore"), ".env.local\n.guest-cache\n");
    const first = await f.coordinator.requestForSessionV2(f.request("first-draft", f.guest));
    expect(first.status).toBe("published");
    if (first.status !== "published") {
      throw new Error("Fixture publication failed");
    }
    const created = mocks.runCommand.mock.calls.findLast(
      ([argv]) => argv.includes("POST") && argv.some((arg: string) => arg.endsWith("/pulls")),
    )!;
    const pr = {
      url: first.url,
      userId: 42,
      state: "open",
      body: JSON.parse(created[1].input).body,
      headSha: first.headCommit,
      headRef: first.branch,
      baseRef: "main",
    };
    const { runCommandBuffered } =
      await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
    const upstream = path.join(path.dirname(local.cwd), "upstream");
    await local.git("clone", "--no-local", "--branch", "main", local.cwd, upstream);
    await fs.writeFile(path.join(upstream, "artifact.txt"), "upstream change\n");
    await fs.writeFile(path.join(upstream, ".gitignore"), ".env.local\n.guest-cache\n");
    await local.git("-C", upstream, "add", "-A");
    await local.git("-C", upstream, "commit", "-m", "Advance selected base");
    let baseCommit = await local.git("-C", upstream, "rev-parse", "HEAD");
    const ancestorCommit = await local.git(
      "-C",
      upstream,
      "merge-base",
      first.headCommit,
      baseCommit,
    );
    const ancestorBlob = await local.git(
      "-C",
      upstream,
      "rev-parse",
      `${ancestorCommit}:artifact.txt`,
    );
    // Criss-cross tips have two merge bases; merging those bases needs their older blob too.
    await local.git("-C", upstream, "checkout", "-b", "feature", first.headCommit);
    await local.git("-C", upstream, "merge", "--no-edit", "-s", "ours", baseCommit);
    const featureMerge = await local.git("-C", upstream, "rev-parse", "HEAD");
    await local.git("-C", upstream, "checkout", "main");
    await local.git("-C", upstream, "merge", "--no-edit", "-s", "ours", first.headCommit);
    await fs.writeFile(path.join(upstream, "upstream.txt"), "unrelated upstream file\n");
    await local.git("-C", upstream, "add", "upstream.txt");
    await local.git("-C", upstream, "commit", "-m", "Advance selected contents");
    baseCommit = await local.git("-C", upstream, "rev-parse", "HEAD");
    const partialBase = baseCommit;
    const missingBlob = await local.git("-C", upstream, "rev-parse", "HEAD:upstream.txt");
    const upstreamUrl = pathToFileURL(upstream).href;
    await local.git("-C", upstream, "config", "uploadpack.allowFilter", "true");
    await local.git("config", "remote.fixture.url", upstreamUrl);
    await local.git("config", "remote.fixture.promisor", "true");
    await local.git("fetch", "--filter=blob:none", "--no-write-fetch-head", "fixture", baseCommit);
    await local.git(
      "fetch",
      "--filter=blob:none",
      "--no-write-fetch-head",
      "fixture",
      featureMerge,
    );
    await local.git("update-ref", `refs/heads/${first.branch}`, featureMerge);
    await local.git("update-ref", "refs/heads/main", baseCommit);
    expect((await local.git("merge-base", "--all", "HEAD", baseCommit)).split("\n")).toHaveLength(
      2,
    );
    await local.git("config", "remote.fixture.url", path.join(upstream, "unavailable-promisor"));
    const missingContents = (commit = partialBase) =>
      local.git(
        "rev-list",
        "--objects",
        "--missing=print",
        "--no-object-names",
        "--max-count=1",
        commit,
      );
    expect(await missingContents()).toContain(`?${missingBlob}`);
    let rejectContentFetch = true;
    let contentFetches = 0;
    let commitFetches = 0;
    let cancelAfterScan: AbortController | undefined;
    await fs.writeFile(path.join(local.cwd, ".env.local"), "host-private-fixture");
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.some((arg) => arg.startsWith("repos/openclaw/openclaw/git/ref/heads/"))) {
        return commandResult(JSON.stringify({ ref: "refs/heads/main", sha: baseCommit }));
      }
      if (argv.includes("fetch") && (argv.includes(partialBase) || argv.includes("--stdin"))) {
        expect(argv).toContain("https://github.com/openclaw/openclaw.git");
        expect(argv).toContain("credential.helper=!gh auth git-credential");
        if (argv.includes("--stdin")) {
          contentFetches++;
          if (rejectContentFetch) {
            return commandResult("", 1);
          }
        } else {
          commitFetches++;
        }
        return await runCommandBuffered(
          argv.map((arg) =>
            arg === "https://github.com/openclaw/openclaw.git" ? upstreamUrl : arg,
          ),
          { ...options, cwd: local.cwd, timeoutMs: 10_000 },
        );
      }
      if (argv.includes("state=all")) {
        return commandResult(JSON.stringify([pr]));
      }
      const result = await transport(argv, options);
      if (argv.includes("--missing=print")) {
        cancelAfterScan?.abort(new Error("refresh cancelled after object discovery"));
      }
      if (argv.includes("push")) {
        pr.headSha = await local.git("rev-parse", "HEAD");
      }
      return result;
    });
    using owner = await resolveLocalWorkspaceOwner({
      ...f.guestSource.session,
      cfg: f.config,
      assertCurrent: f.guest.assertCurrent,
    });
    if (!owner) {
      throw new Error("Fixture managed workspace unavailable");
    }
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    await fs.writeFile(path.join(projection, "artifact.txt"), "guest saved change\n");
    await fs.writeFile(path.join(projection, "guest.txt"), "saved independent work\n");
    await fs.writeFile(path.join(projection, ".guest-cache"), "saved ignored guest work\n");
    await fs.mkdir(path.join(projection, "empty-guest-directory"));
    await fs.appendFile(path.join(projection, ".git/config"), "\n[credential]\nhelper = !false\n");
    const reviewTransferBytes: number[] = [];
    const sandbox = createSandboxTestContext({
      overrides: {
        sessionKey: f.session.sessionKey,
        workspaceDir: projection,
        containerWorkdir: projection,
        workspaceSource: "managed-worktree",
        backend: {
          id: "docker",
          runtimeId: "fixture",
          runtimeLabel: "fixture",
          workdir: projection,
          buildExecSpec: async () => {
            throw new Error("Fixture does not expose arbitrary exec");
          },
          runShellCommand: async ({ script, args, stdin, signal }) => {
            if (stdin) {
              reviewTransferBytes.push(Buffer.byteLength(stdin));
            }
            const result = await runCommandBuffered(
              ["sh", "-c", script, "sandbox-fixture", ...(args ?? [])],
              {
                cwd: projection,
                input: stdin,
                signal,
                timeoutMs: 10_000,
                env: {
                  ...process.env,
                  GH_TOKEN: undefined,
                  GITHUB_TOKEN: undefined,
                  GH_CONFIG_DIR: undefined,
                },
              },
            );
            if (result.code === null) {
              throw new Error("Fixture sandbox command did not exit");
            }
            return { code: result.code, stdout: result.stdout, stderr: result.stderr };
          },
        },
      },
    });
    const guestGit = async (...args: string[]) => {
      const result = await sandbox.backend!.runShellCommand({ script: 'git "$@"', args });
      if (result.code !== 0) {
        throw new Error(result.stderr.toString());
      }
      return result.stdout.toString().trim();
    };
    const guestHead = await guestGit("rev-parse", "HEAD");
    const invoke = async (
      args: Record<string, unknown>,
      prepared: typeof sandbox | null = sandbox,
      signal?: AbortSignal,
    ) => {
      const callGateway: InProcessGatewayCaller = async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        const respond = vi.fn();
        await handleGatewayRequest({
          req: { type: "req", id: randomUUID(), method, params },
          client: f.guestSource.client,
          context: Object.assign(createRequestContext(), f.guestSource.context, {
            githubPublicationService: f.coordinator,
            workerSessionPlacementService: f.placements,
          }),
          isWebchatConnect: () => false,
          respond,
          signal,
        });
        expect(respond).toHaveBeenCalledOnce();
        const [ok, result, error] = respond.mock.calls[0]!;
        if (!ok) {
          throw new Error(error.message);
        }
        return result as T;
      };
      const result = await withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: f.session.sessionKey },
        () => createGitHubPublishTool({ callGateway, sandbox: prepared }).execute("refresh", args),
      );
      return result.details;
    };
    // Snapshot preparation can pack a second copy; retain every other object in one promisor pack.
    const hostObjects = path.join(local.cwd, ".git", "objects");
    const hostPackDirectory = path.join(hostObjects, "pack");
    const hostPacks = (await fs.readdir(hostPackDirectory)).filter((file) =>
      file.endsWith(".pack"),
    );
    const retainedHostObjects = (
      await local.git("cat-file", "--batch-all-objects", "--batch-check=%(objectname)")
    )
      .split("\n")
      .filter((object) => object !== ancestorBlob);
    const partialHostPack = await runCommandBuffered(
      ["git", "pack-objects", "--stdout", "--no-reuse-delta", "--window=0"],
      { cwd: local.cwd, input: `${retainedHostObjects.join("\n")}\n`, timeoutMs: 10_000 },
    );
    expect(partialHostPack.code).toBe(0);
    const importedHostPack = await runCommandBuffered(
      ["git", "index-pack", "--stdin", "--promisor"],
      { cwd: local.cwd, input: partialHostPack.stdout, timeoutMs: 10_000 },
    );
    expect(importedHostPack.code).toBe(0);
    const hostPackHash = importedHostPack.stdout.toString().trim().split(/\s+/u).at(-1);
    for (const pack of hostPacks) {
      if (pack === `pack-${hostPackHash}.pack`) {
        continue;
      }
      for (const extension of ["pack", "idx", "rev", "promisor", "bitmap"]) {
        await fs.rm(path.join(hostPackDirectory, pack.replace(/\.pack$/u, `.${extension}`)), {
          force: true,
        });
      }
    }
    await fs.rm(path.join(hostObjects, ancestorBlob.slice(0, 2), ancestorBlob.slice(2)));
    expect(await missingContents(ancestorCommit)).toContain(`?${ancestorBlob}`);
    const beforeAdmission = await local.git("rev-parse", "HEAD");
    await expect(invoke({ action: "refresh_base" }, null)).rejects.toThrow("sandboxed agent");
    await expect(
      invoke({ action: "refresh_base" }, { ...sandbox, workspaceAccess: "ro" }),
    ).rejects.toThrow("read-only");
    expect(await local.git("rev-parse", "HEAD")).toBe(beforeAdmission);
    expect(await fs.readFile(path.join(local.cwd, "artifact.txt"), "utf8")).toBe("accepted\n");
    await expect(invoke({ action: "refresh_base" })).rejects.toThrow(
      "base contents could not be fetched",
    );
    expect(contentFetches).toBe(1);
    expect(await missingContents()).toContain(`?${missingBlob}`);
    expect(await local.git("rev-parse", "HEAD")).toBe(beforeAdmission);
    expect(await fs.readFile(path.join(projection, "artifact.txt"), "utf8")).toBe(
      "guest saved change\n",
    );
    expect(await fs.readFile(path.join(projection, "guest.txt"), "utf8")).toBe(
      "saved independent work\n",
    );
    cancelAfterScan = new AbortController();
    await expect(
      invoke({ action: "refresh_base" }, sandbox, cancelAfterScan.signal),
    ).rejects.toThrow();
    expect(cancelAfterScan.signal.aborted).toBe(true);
    expect(contentFetches).toBe(1);
    expect(await missingContents()).toContain(`?${missingBlob}`);
    cancelAfterScan = undefined;
    rejectContentFetch = false;
    const stage = workerWorkspaceResultStaging.stageWorkerWorkspaceResult;
    let stagedRefresh = "";
    const stageInterruption = vi
      .spyOn(workerWorkspaceResultStaging, "stageWorkerWorkspaceResult")
      .mockImplementation(async (params) => {
        const result = await stage(params);
        if (isLocalWorkspaceBaseRefreshRef(params.stagedResultRef)) {
          stagedRefresh = params.stagedResultRef;
          throw new Error("interrupted before refresh reservation");
        }
        return result;
      });
    await expect(invoke({ action: "refresh_base" })).rejects.toThrow(
      "interrupted before refresh reservation",
    );
    stageInterruption.mockRestore();
    expect(stagedRefresh).not.toBe("");
    const stagedHead = await local.git("rev-parse", "HEAD");
    const stagedBaseline = await workspaceStore.withLocalWorkspaceStore(
      { worktreeId: owner.worktree.id },
      async (store) => store.get(),
    );
    expect(stagedBaseline?.pending_ref).toBeNull();
    await fs.appendFile(path.join(projection, ".guest-cache"), "saved after interruption\n");
    await fs.mkdir(path.join(projection, "later-empty-guest-directory"));
    await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
    const advancedBaseline = await workspaceStore.withLocalWorkspaceStore(
      { worktreeId: owner.worktree.id },
      async (store) => store.get(),
    );
    expect(advancedBaseline?.baseline_ref).not.toBe(stagedBaseline?.baseline_ref);
    expect(await local.git("rev-parse", "HEAD")).toBe(stagedHead);
    const withStore = workspaceStore.withLocalWorkspaceStore;
    const reservationInterruption = vi
      .spyOn(workspaceStore, "withLocalWorkspaceStore")
      .mockImplementation((params, operation) =>
        withStore(params, (store) =>
          operation({
            ...store,
            update: async (row, patch, authority) => {
              if (
                patch.pending_target === "canonical" &&
                isLocalWorkspaceBaseRefreshRef(patch.pending_ref ?? null)
              ) {
                throw new Error("interrupted before refresh reservation");
              }
              return await store.update(row, patch, authority);
            },
          }),
        ),
      );
    await expect(invoke({ action: "refresh_base" })).rejects.toThrow(
      "interrupted before refresh reservation",
    );
    reservationInterruption.mockRestore();
    expect(await local.git("rev-parse", "MERGE_HEAD")).toBe(baseCommit);
    await fs.writeFile(
      path.join(projection, "artifact.txt"),
      "guest saved change after native preparation\n",
    );
    await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
    // Fail after the real canonical receipt, before projection application; retry uses its retained payload.
    let interrupted = false;
    const interruption = vi
      .spyOn(workspaceStore, "withLocalWorkspaceStore")
      .mockImplementation((params, operation) =>
        withStore(params, (store) =>
          operation({
            ...store,
            update: async (row, patch, authority) => {
              const result = await store.update(row, patch, authority);
              if (
                !interrupted &&
                patch.pending_target === "projection" &&
                isLocalWorkspaceBaseRefreshRef(result.pending_ref)
              ) {
                interrupted = true;
                throw new Error("interrupted after canonical acceptance");
              }
              return result;
            },
          }),
        ),
      );
    const interruptionFailure = await invoke({ action: "refresh_base" }).catch(
      (error: unknown) => error,
    );
    expect(interrupted, String(interruptionFailure)).toBe(true);
    expect(interruptionFailure).toBeInstanceOf(Error);
    interruption.mockRestore();
    const pendingRefresh = await withStore({ worktreeId: owner.worktree.id }, async (store) =>
      store.get(),
    );
    expect(pendingRefresh).toMatchObject({ pending_target: "projection", journal_json: null });
    expect(pendingRefresh?.base_commit).not.toBe(baseCommit);
    const refreshed = await invoke({ action: "refresh_base" });
    expect(refreshed).toMatchObject({
      status: "conflicts",
      baseCommit,
      conflictPaths: ["artifact.txt"],
    });
    const conflictedSource = await fs.readFile(path.join(projection, "artifact.txt"), "utf8");
    expect(conflictedSource).toContain("<<<<<<<");
    expect(conflictedSource).toContain("guest saved change after native preparation");
    expect(await fs.readFile(path.join(projection, "upstream.txt"), "utf8")).toBe(
      "unrelated upstream file\n",
    );
    expect(await fs.readFile(path.join(projection, "guest.txt"), "utf8")).toBe(
      "saved independent work\n",
    );
    expect(await fs.readFile(path.join(projection, ".guest-cache"), "utf8")).toBe(
      "saved ignored guest work\nsaved after interruption\n",
    );
    expect((await fs.stat(path.join(projection, "empty-guest-directory"))).isDirectory()).toBe(
      true,
    );
    expect(
      (await fs.stat(path.join(projection, "later-empty-guest-directory"))).isDirectory(),
    ).toBe(true);
    expect(
      await local.git(
        "for-each-ref",
        "--format=%(refname)",
        "refs/openclaw/workspace-base-refresh",
      ),
    ).toBe("");
    await expect(fs.stat(path.join(projection, ".env.local"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const fetchesBeforePendingRetry = commitFetches;
    expect(await invoke({ action: "refresh_base" })).toMatchObject({
      status: "conflicts",
      baseCommit,
    });
    expect(commitFetches).toBe(fetchesBeforePendingRetry);
    await expect(
      withLocalWorkspaceProjection(owner, async (state) =>
        state.prepareArchive(await local.git("rev-parse", "HEAD")),
      ),
    ).rejects.toThrow("before archiving");
    await expect(
      f.coordinator.requestForSessionV2(f.request("unresolved", f.guest)),
    ).rejects.toThrow("refresh_base");
    await expect(
      invoke({ action: "refresh_base", conflictsResolved: true, baseCommit: "a".repeat(40) }),
    ).rejects.toThrow("changed");
    await expect(
      invoke({ action: "refresh_base", conflictsResolved: true, baseCommit }),
    ).rejects.toThrow("Conflict markers");
    await fs.writeFile(
      path.join(projection, "artifact.txt"),
      "upstream change\nguest saved change after native preparation\n",
    );
    expect(
      await invoke({ action: "refresh_base", conflictsResolved: true, baseCommit }),
    ).toMatchObject({ status: "refreshed", baseCommit });
    await local.git("merge-base", "--is-ancestor", baseCommit, "HEAD");
    expect(await guestGit("rev-parse", "HEAD")).toBe(guestHead);
    expect(await guestGit("rev-parse", "refs/openclaw/review-base")).toBe(baseCommit);
    // The canonical helper's local/base target captures this staged diff, not the old guest HEAD.
    const reviewPaths = (await guestGit("diff", "--cached", "--name-only", baseCommit)).split("\n");
    expect(reviewPaths).toContain("artifact.txt");
    expect(reviewPaths).toContain("guest.txt");
    expect(reviewPaths).not.toContain("upstream.txt");
    expect(await guestGit("diff", "--name-only")).toBe("");
    const final = await f.coordinator.requestForSessionV2(f.request("resolved-draft", f.guest));
    expect(final).toMatchObject({ status: "published", url: first.url, branch: first.branch });
    expect(f.publishedTitles).toEqual(["first-draft"]);
    await local.git("merge-base", "--is-ancestor", baseCommit, "HEAD");
    expect(await local.git("show", "HEAD:upstream.txt")).toBe("unrelated upstream file");
    expect(await local.git("show", "HEAD:artifact.txt")).toBe(
      "upstream change\nguest saved change after native preparation",
    );
    expect(await fs.readFile(path.join(local.cwd, ".env.local"), "utf8")).toBe(
      "host-private-fixture",
    );
    await local.git("checkout", "main");
    await fs.writeFile(path.join(local.cwd, "later-upstream.txt"), "later upstream only\n");
    await local.git("add", "later-upstream.txt");
    await local.git("commit", "-m", "Advance base without conflicts");
    baseCommit = await local.git("rev-parse", "HEAD");
    await local.git("checkout", first.branch);
    expect(await invoke({ action: "refresh_base" })).toMatchObject({
      status: "refreshed",
      review: { mode: "local", base: baseCommit },
    });
    expect(await guestGit("rev-parse", "HEAD")).toBe(guestHead);
    expect(
      (await guestGit("diff", "--cached", "--name-only", baseCommit)).split("\n"),
    ).not.toContain("later-upstream.txt");
    expect(await invoke({ action: "refresh_base" })).toMatchObject({
      status: "current",
      review: { mode: "local", base: baseCommit },
    });
    // An unchanged source snapshot must not retransmit repository contents.
    expect(reviewTransferBytes.at(-1)).toBeLessThanOrEqual(64);
    const runShellCommand = sandbox.backend!.runShellCommand.bind(sandbox.backend);
    const missingDonor = vi.spyOn(sandbox.backend!, "runShellCommand").mockResolvedValueOnce({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    expect(await invoke({ action: "refresh_base" })).toMatchObject({ status: "current" });
    missingDonor.mockRestore();
    const fullTransferBytes = reviewTransferBytes.at(-1);
    expect(fullTransferBytes).toBeGreaterThan(64);

    // An existing but unadvertised host commit cannot become a guest-chosen donor.
    const hostOnlyCommit = await local.git(
      "commit-tree",
      await local.git("rev-parse", `${baseCommit}^{tree}`),
      "-m",
      "Host-only donor",
    );
    const mismatchedDonor = vi.spyOn(sandbox.backend!, "runShellCommand").mockResolvedValueOnce({
      code: 0,
      stdout: Buffer.from(hostOnlyCommit),
      stderr: Buffer.alloc(0),
    });
    expect(await invoke({ action: "refresh_base" })).toMatchObject({ status: "current" });
    mismatchedDonor.mockRestore();
    expect(reviewTransferBytes.at(-1)).toBe(fullTransferBytes);

    // Losing retained objects after the availability probe must recover the full
    // selected source, including omitted blobs that are not delta bases.
    const packDirectory = path.join(projection, ".git", "objects", "pack");
    const packs = (await fs.readdir(packDirectory)).filter((file) => file.endsWith(".pack"));
    const missingDonorBlob = await guestGit("rev-parse", `${baseCommit}:later-upstream.txt`);
    const retainedObjects = (
      await guestGit("rev-list", "--objects", "--no-object-names", `${baseCommit}^{tree}`)
    )
      .split("\n")
      .filter((object) => object !== missingDonorBlob);
    const incompletePack = await runCommandBuffered(
      ["git", "pack-objects", "--stdout", "--no-reuse-delta", "--window=0"],
      {
        cwd: projection,
        input: [...retainedObjects, baseCommit, ""].join("\n"),
        timeoutMs: 10_000,
      },
    );
    expect(incompletePack.code).toBe(0);
    const installedIncomplete = await runCommandBuffered(["git", "index-pack", "--stdin"], {
      cwd: projection,
      input: incompletePack.stdout,
      timeoutMs: 10_000,
    });
    expect(installedIncomplete.code).toBe(0);
    let removedRetained = false;
    const donorLoss = vi
      .spyOn(sandbox.backend!, "runShellCommand")
      .mockImplementation(async (command) => {
        if (command.stdin && !removedRetained) {
          removedRetained = true;
          // Keep the original guest snapshot while making the selected review
          // snapshot incomplete.
          for (const pack of packs) {
            const index = pack.replace(/\.pack$/u, ".idx");
            const objects = await runCommandBuffered(
              ["git", "verify-pack", "-v", path.join(packDirectory, index)],
              {
                cwd: projection,
                timeoutMs: 10_000,
              },
            );
            if (objects.stdout.toString().includes(guestHead)) {
              continue;
            }
            await fs.rm(path.join(packDirectory, pack));
            await fs.rm(path.join(packDirectory, index));
          }
          const absent = await runCommandBuffered(["git", "cat-file", "-e", missingDonorBlob], {
            cwd: projection,
            timeoutMs: 10_000,
          });
          expect(absent.code).not.toBe(0);
          expect(await guestGit("rev-parse", `${baseCommit}^{tree}`)).not.toBe("");
        }
        return await runShellCommand(command);
      });
    const beforeLoss = reviewTransferBytes.length;
    expect(await invoke({ action: "refresh_base" })).toMatchObject({ status: "current" });
    donorLoss.mockRestore();
    expect(removedRetained).toBe(true);
    expect(reviewTransferBytes.slice(beforeLoss)).toHaveLength(2);
    expect(reviewTransferBytes.at(-1)).toBeGreaterThan(64);
    expect(await guestGit("show", `${baseCommit}:later-upstream.txt`)).toBe("later upstream only");
    expect(await guestGit("rev-parse", "HEAD")).toBe(guestHead);

    await local.git("checkout", "main");
    await fs.writeFile(
      path.join(local.cwd, "retry-upstream.txt"),
      "upstream before interrupted import\n",
    );
    await local.git("add", "retry-upstream.txt");
    await local.git("commit", "-m", "Advance before interrupted review import");
    baseCommit = await local.git("rev-parse", "HEAD");
    await local.git("checkout", first.branch);

    // A lost acknowledgment after real import must reuse the installed target.
    const importInterruption = vi
      .spyOn(sandbox.backend!, "runShellCommand")
      .mockImplementation(async (command) => {
        const result = await runShellCommand(command);
        if (command.stdin) {
          expect(result.code).toBe(0);
          throw new Error("interrupted after review-base import");
        }
        return result;
      });
    await expect(invoke({ action: "refresh_base" })).rejects.toThrow(
      "interrupted after review-base import",
    );
    importInterruption.mockRestore();
    expect(await invoke({ action: "refresh_base" })).toMatchObject({ status: "current" });
    expect(reviewTransferBytes.at(-1)).toBeLessThanOrEqual(64);
    expect(await guestGit("show", `${baseCommit}:retry-upstream.txt`)).toBe(
      "upstream before interrupted import",
    );
    expect(await guestGit("rev-parse", "HEAD")).toBe(guestHead);
    expect(contentFetches).toBe(3);
    expect(await missingContents(ancestorCommit)).not.toContain("?");
    expect(await missingContents()).not.toContain("?");
    const transfersBeforeRevocation = reviewTransferBytes.length;
    let revokedAfterProbe = false;
    const revokeDuringProbe = vi
      .spyOn(sandbox.backend!, "runShellCommand")
      .mockImplementationOnce(async (command) => {
        expect(command.stdin).toBeUndefined();
        const result = await runShellCommand(command);
        expect(result.code).toBe(0);
        await f.revoke();
        revokedAfterProbe = true;
        return result;
      });
    await expect(invoke({ action: "refresh_base" })).rejects.toThrow();
    expect(revokedAfterProbe).toBe(true);
    expect(revokeDuringProbe).toHaveBeenCalledTimes(1);
    expect(reviewTransferBytes).toHaveLength(transfersBeforeRevocation);
    revokeDuringProbe.mockRestore();
    await expect(invoke({ action: "refresh_base" })).rejects.toThrow();
  });
});
