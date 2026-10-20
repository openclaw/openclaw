// Install the existing synthetic GitHub transport before loading publication owners.
// oxfmt-ignore
import { publicationCheckpoint as checkpoint } from "./github-publication-actions.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
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
import { dispatchAuthorizationRequest } from "./server-methods.authorization.test-support.js";
import { createContext as createRequestContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  resolveLocalWorkspaceOwner,
  withLocalWorkspaceProjection,
} from "./worker-environments/local-workspace-projection.js";
import * as workspaceStore from "./worker-environments/local-workspace-store.js";
import { isLocalWorkspaceBaseRefreshRef } from "./worker-environments/workspace-result-inventory.js";
import { workerWorkspaceResultStaging } from "./worker-environments/workspace-result-staging.js";

const mocks = githubPublicationTestMocks();

const write = (root: string, file: string, contents: string) =>
  fs.writeFile(path.join(root, file), contents);
const read = (root: string, file: string) => fs.readFile(path.join(root, file), "utf8");
async function expectFile(root: string, file: string, contents: string) {
  expect(await read(root, file)).toBe(contents);
}

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
  const { git, cwd } = f.local!;
  const unchangedInput = ".artifacts/build-cache-inputs/retained.json";
  await fs.mkdir(path.dirname(path.join(cwd, unchangedInput)), { recursive: true });
  await write(cwd, unchangedInput, "retained original input\n");
  await git("add", "--force", "--", unchangedInput);
  await write(cwd, ".gitignore", ".env.local\n.guest-cache\n");
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
  const runGit = (directory: string, args: string[], input?: string | Buffer) =>
    runCommandBuffered(["git", ...args], { cwd: directory, input, timeoutMs: 10_000 });
  const installPack = async (directory: string, objects: string[], promisor = false) => {
    const packed = await runGit(
      directory,
      ["pack-objects", "--stdout", "--no-reuse-delta", "--window=0"],
      objects.join("\n") + "\n",
    );
    expect(packed.code).toBe(0);
    const installed = await runGit(
      directory,
      ["index-pack", "--stdin", ...(promisor ? ["--promisor"] : [])],
      packed.stdout,
    );
    expect(installed.code).toBe(0);
    return installed.stdout.toString().trim().split(/\s+/u).at(-1);
  };
  const upstream = path.join(path.dirname(cwd), "upstream");
  const upstreamGit = (...args: string[]) => git("-C", upstream, ...args);
  await git("clone", "--no-local", "--branch", "main", cwd, upstream);
  await write(upstream, "artifact.txt", "upstream-v2\n");
  await write(upstream, ".gitignore", ".env.local\n.guest-cache\n");
  await upstreamGit("add", "-A");
  await upstreamGit("commit", "-m", "Advance selected base");
  let baseCommit = await upstreamGit("rev-parse", "HEAD");
  const ancestorCommit = await upstreamGit("merge-base", first.headCommit, baseCommit);
  const ancestorBlob = await upstreamGit("rev-parse", `${ancestorCommit}:artifact.txt`);
  // Criss-cross tips have two merge bases; merging those bases needs their older blob too.
  await upstreamGit("checkout", "-b", "feature", first.headCommit);
  await upstreamGit("merge", "--no-edit", "-s", "ours", baseCommit);
  const featureMerge = await upstreamGit("rev-parse", "HEAD");
  await upstreamGit("checkout", "main");
  await upstreamGit("merge", "--no-edit", "-s", "ours", first.headCommit);
  await write(upstream, "upstream.txt", "unrelated upstream file\n");
  // The synthetic ours merges otherwise record this feature input as a base-side deletion.
  await fs.mkdir(path.dirname(path.join(upstream, unchangedInput)), { recursive: true });
  await write(upstream, unchangedInput, "retained original input\n");
  const upstreamInputs = [
    ".artifacts/build-all-cache/source.txt",
    ".artifacts/build-cache-inputs/source.json",
  ];
  for (const entryPath of upstreamInputs) {
    await fs.mkdir(path.dirname(path.join(upstream, entryPath)), { recursive: true });
    await write(upstream, entryPath, "upstream original input\n");
  }
  await upstreamGit("add", "upstream.txt", unchangedInput, ...upstreamInputs);
  await upstreamGit("commit", "-m", "Advance selected contents");
  baseCommit = await upstreamGit("rev-parse", "HEAD");
  for (const commit of [first.headCommit, baseCommit]) {
    expect(await upstreamGit("show", `${commit}:${unchangedInput}`)).toBe(
      "retained original input",
    );
  }
  const partialBase = baseCommit;
  const missingBlob = await upstreamGit("rev-parse", "HEAD:upstream.txt");
  const upstreamUrl = pathToFileURL(upstream).href;
  await upstreamGit("config", "uploadpack.allowFilter", "true");
  await git("config", "remote.fixture.url", upstreamUrl);
  await git("config", "remote.fixture.promisor", "true");
  await git("fetch", "--filter=blob:none", "--no-write-fetch-head", "fixture", baseCommit);
  await git("fetch", "--filter=blob:none", "--no-write-fetch-head", "fixture", featureMerge);
  await git("update-ref", `refs/heads/${first.branch}`, featureMerge);
  await git("update-ref", "refs/heads/main", baseCommit);
  expect((await git("merge-base", "--all", "HEAD", baseCommit)).split("\n")).toHaveLength(2);
  await git("config", "remote.fixture.url", path.join(upstream, "unavailable-promisor"));
  const missingContents = (commit = partialBase) =>
    git("rev-list", "--objects", "--missing=print", "--no-object-names", "--max-count=1", commit);
  expect(await missingContents()).toContain(`?${missingBlob}`);
  let rejectContentFetch = true;
  let contentFetches = 0;
  let commitFetches = 0;
  let cancelAfterScan: AbortController | undefined;
  await write(cwd, ".env.local", "host-private-fixture");
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
        argv.map((arg) => (arg === "https://github.com/openclaw/openclaw.git" ? upstreamUrl : arg)),
        { ...options, cwd, timeoutMs: 10_000 },
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
      pr.headSha = await git("rev-parse", "HEAD");
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
  const baseline = () =>
    workspaceStore.withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) =>
      store.get(),
    );
  const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  await expectFile(projection, unchangedInput, "retained original input\n");
  const disposableCache = ".artifacts/build-all-cache/guest-generated.js";
  await fs.mkdir(path.dirname(path.join(projection, disposableCache)), { recursive: true });
  await write(projection, disposableCache, "disposable guest cache\n");
  await write(projection, "artifact.txt", "guest-v1\n");
  await write(projection, "guest.txt", "independent guest work\n");
  await write(projection, ".guest-cache", "ignored guest work\n");
  await fs.mkdir(path.join(projection, "initial-empty"));
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
  const refresh = async (
    args: Record<string, unknown> = {},
    prepared: typeof sandbox | null = sandbox,
    signal?: AbortSignal,
  ) => {
    const callGateway: InProcessGatewayCaller = async <T>(
      method: string,
      params: Record<string, unknown>,
    ) => {
      const respond = await dispatchAuthorizationRequest(
        method,
        params,
        {
          client: f.guestSource.client,
          context: Object.assign(createRequestContext(), f.guestSource.context, {
            githubPublicationService: f.coordinator,
            workerSessionPlacementService: f.placements,
          }),
          signal,
        },
        randomUUID(),
      );
      expect(respond).toHaveBeenCalledOnce();
      const [ok, result, error] = respond.mock.calls[0]!;
      if (!ok) {
        throw new Error(error.message);
      }
      return result as T;
    };
    const result = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: f.session.sessionKey },
      () =>
        createGitHubPublishTool({ callGateway, sandbox: prepared }).execute("refresh", {
          action: "refresh_base",
          ...args,
        }),
    );
    return result.details;
  };
  // Snapshot preparation can pack a second copy; retain every other object in one promisor pack.
  const hostObjects = path.join(cwd, ".git", "objects");
  const hostPackDirectory = path.join(hostObjects, "pack");
  const hostPacks = (await fs.readdir(hostPackDirectory)).filter((file) => file.endsWith(".pack"));
  const retainedHostObjects = (
    await git("cat-file", "--batch-all-objects", "--batch-check=%(objectname)")
  )
    .split("\n")
    .filter((object) => object !== ancestorBlob);
  const hostPackHash = await installPack(cwd, retainedHostObjects, true);
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
  const beforeAdmission = await git("rev-parse", "HEAD");
  await expect(refresh({}, null)).rejects.toThrow("merge the base with git in their workspace");
  await expect(refresh({}, { ...sandbox, workspaceAccess: "ro" })).rejects.toThrow(
    "writable managed sandbox workspace",
  );
  expect(await git("rev-parse", "HEAD")).toBe(beforeAdmission);
  await expectFile(cwd, "artifact.txt", "accepted\n");
  await expect(refresh()).rejects.toThrow("base contents could not be fetched");
  expect(contentFetches).toBe(1);
  expect(await missingContents()).toContain(`?${missingBlob}`);
  expect(await git("rev-parse", "HEAD")).toBe(beforeAdmission);
  await expectFile(projection, "artifact.txt", "guest-v1\n");
  await expectFile(projection, "guest.txt", "independent guest work\n");
  cancelAfterScan = new AbortController();
  await expect(refresh({}, sandbox, cancelAfterScan.signal)).rejects.toThrow();
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
  await expect(refresh()).rejects.toThrow("interrupted before refresh reservation");
  stageInterruption.mockRestore();
  expect(stagedRefresh).not.toBe("");
  const stagedHead = await git("rev-parse", "HEAD");
  const stagedBaseline = await baseline();
  expect(stagedBaseline?.pending_ref).toBeNull();
  await fs.appendFile(path.join(projection, ".guest-cache"), "post-interruption\n");
  await fs.mkdir(path.join(projection, "later-empty"));
  await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
  const advancedBaseline = await baseline();
  expect(advancedBaseline?.baseline_ref).not.toBe(stagedBaseline?.baseline_ref);
  expect(await git("rev-parse", "HEAD")).toBe(stagedHead);
  const withStore = workspaceStore.withLocalWorkspaceStore;
  type Store = Parameters<Parameters<typeof withStore>[1]>[0];
  const interceptUpdate = (intercept: (update: Store["update"]) => Store["update"]) =>
    vi
      .spyOn(workspaceStore, "withLocalWorkspaceStore")
      .mockImplementation((params, operation) =>
        withStore(params, (store) => operation({ ...store, update: intercept(store.update) })),
      );
  const reservationInterruption = interceptUpdate((update) => async (row, patch, authority) => {
    if (
      patch.pending_target === "canonical" &&
      isLocalWorkspaceBaseRefreshRef(patch.pending_ref ?? null)
    ) {
      throw new Error("interrupted before refresh reservation");
    }
    return await update(row, patch, authority);
  });
  await expect(refresh()).rejects.toThrow("interrupted before refresh reservation");
  reservationInterruption.mockRestore();
  expect(await git("rev-parse", "MERGE_HEAD")).toBe(baseCommit);
  await write(projection, "artifact.txt", "guest-v2\n");
  await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
  // Fail after the real canonical receipt, before projection application; retry uses its retained payload.
  let interrupted = false;
  const interruption = interceptUpdate((update) => async (row, patch, authority) => {
    const result = await update(row, patch, authority);
    if (
      !interrupted &&
      patch.pending_target === "projection" &&
      isLocalWorkspaceBaseRefreshRef(result.pending_ref)
    ) {
      interrupted = true;
      throw new Error("interrupted after canonical acceptance");
    }
    return result;
  });
  const interruptionFailure = await refresh().catch((error: unknown) => error);
  expect(interrupted, String(interruptionFailure)).toBe(true);
  expect(interruptionFailure).toBeInstanceOf(Error);
  interruption.mockRestore();
  const pendingRefresh = await baseline();
  expect(pendingRefresh).toMatchObject({ pending_target: "projection", journal_json: null });
  expect(pendingRefresh?.base_commit).not.toBe(baseCommit);
  const refreshed = await refresh();
  expect(refreshed).toMatchObject({
    status: "conflicts",
    baseCommit,
    conflictPaths: ["artifact.txt"],
  });
  const conflictedSource = await read(projection, "artifact.txt");
  expect(conflictedSource).toContain("<<<<<<<");
  expect(conflictedSource).toContain("guest-v2");
  await expectFile(projection, "upstream.txt", "unrelated upstream file\n");
  await expectFile(projection, unchangedInput, "retained original input\n");
  await expect(fs.stat(path.join(cwd, disposableCache))).rejects.toMatchObject({
    code: "ENOENT",
  });
  for (const entryPath of upstreamInputs) {
    await expectFile(projection, entryPath, "upstream original input\n");
  }
  await expectFile(projection, "guest.txt", "independent guest work\n");
  await expectFile(projection, ".guest-cache", "ignored guest work\npost-interruption\n");
  expect((await fs.stat(path.join(projection, "initial-empty"))).isDirectory()).toBe(true);
  expect((await fs.stat(path.join(projection, "later-empty"))).isDirectory()).toBe(true);
  expect(
    await git("for-each-ref", "--format=%(refname)", "refs/openclaw/workspace-base-refresh"),
  ).toBe("");
  await expect(fs.stat(path.join(projection, ".env.local"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const fetchesBeforePendingRetry = commitFetches;
  expect(await refresh()).toMatchObject({
    status: "conflicts",
    baseCommit,
  });
  expect(commitFetches).toBe(fetchesBeforePendingRetry);
  await expect(
    withLocalWorkspaceProjection(owner, async (state) =>
      state.prepareArchive(await git("rev-parse", "HEAD")),
    ),
  ).rejects.toThrow("before archiving");
  await expect(f.coordinator.requestForSessionV2(f.request("unresolved", f.guest))).rejects.toThrow(
    "refresh_base",
  );
  await expect(refresh({ conflictsResolved: true, baseCommit: "a".repeat(40) })).rejects.toThrow(
    "changed",
  );
  await expect(refresh({ conflictsResolved: true, baseCommit })).rejects.toThrow(
    "Conflict markers",
  );
  await write(projection, "artifact.txt", "upstream-v2\nguest-v2\n");
  expect(await refresh({ conflictsResolved: true, baseCommit })).toMatchObject({
    status: "refreshed",
    baseCommit,
  });
  await git("merge-base", "--is-ancestor", baseCommit, "HEAD");
  expect(await guestGit("rev-parse", "HEAD")).toBe(guestHead);
  expect(await guestGit("rev-parse", "refs/openclaw/review-base")).toBe(baseCommit);
  // The canonical helper's local/base target captures this staged diff, not the old guest HEAD.
  const reviewPaths = (await guestGit("diff", "--cached", "--name-only", baseCommit)).split("\n");
  expect(reviewPaths).toEqual(expect.arrayContaining(["artifact.txt", "guest.txt"]));
  expect(reviewPaths).not.toContain("upstream.txt");
  expect(await guestGit("diff", "--name-only")).toBe("");
  const final = await f.coordinator.requestForSessionV2(f.request("resolved-draft", f.guest));
  expect(final).toMatchObject({ status: "published", url: first.url, branch: first.branch });
  expect(f.publishedTitles).toEqual(["first-draft"]);
  await git("merge-base", "--is-ancestor", baseCommit, "HEAD");
  expect(await git("show", "HEAD:upstream.txt")).toBe("unrelated upstream file");
  for (const entryPath of upstreamInputs) {
    expect(await git("show", `HEAD:${entryPath}`)).toBe("upstream original input");
  }
  expect(await git("show", "HEAD:artifact.txt")).toBe("upstream-v2\nguest-v2");
  await expectFile(cwd, ".env.local", "host-private-fixture");
  await git("checkout", "main");
  await write(cwd, "later-upstream.txt", "later upstream only\n");
  await git("add", "later-upstream.txt");
  await git("commit", "-m", "Advance base without conflicts");
  baseCommit = await git("rev-parse", "HEAD");
  await git("checkout", first.branch);
  expect(await refresh()).toMatchObject({
    status: "refreshed",
    review: { mode: "local", base: baseCommit },
  });
  expect(await guestGit("rev-parse", "HEAD")).toBe(guestHead);
  expect((await guestGit("diff", "--cached", "--name-only", baseCommit)).split("\n")).not.toContain(
    "later-upstream.txt",
  );
  expect(await refresh()).toMatchObject({
    status: "current",
    review: { mode: "local", base: baseCommit },
  });
  // An unchanged source snapshot must not retransmit repository contents.
  expect(reviewTransferBytes.at(-1)).toBeLessThanOrEqual(64);
  const runShellCommand = sandbox.backend!.runShellCommand.bind(sandbox.backend);
  const shellSpy = () => vi.spyOn(sandbox.backend!, "runShellCommand");
  const refreshWithDonor = async (stdout = Buffer.alloc(0)) => {
    const probe = shellSpy().mockResolvedValueOnce({ code: 0, stdout, stderr: Buffer.alloc(0) });
    try {
      expect(await refresh()).toMatchObject({ status: "current" });
      return reviewTransferBytes.at(-1);
    } finally {
      probe.mockRestore();
    }
  };
  const fullTransferBytes = await refreshWithDonor();
  expect(fullTransferBytes).toBeGreaterThan(64);

  // An existing but unadvertised host commit cannot become a guest-chosen donor.
  const hostOnlyCommit = await git(
    "commit-tree",
    await git("rev-parse", `${baseCommit}^{tree}`),
    "-m",
    "Host-only donor",
  );
  expect(await refreshWithDonor(Buffer.from(hostOnlyCommit))).toBe(fullTransferBytes);

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
  await installPack(projection, [...retainedObjects, baseCommit]);
  let removedRetained = false;
  const donorLoss = shellSpy().mockImplementation(async (command) => {
    if (command.stdin && !removedRetained) {
      removedRetained = true;
      // Keep the original guest snapshot while making the selected review
      // snapshot incomplete.
      for (const pack of packs) {
        const index = pack.replace(/\.pack$/u, ".idx");
        const objects = await runGit(projection, [
          "verify-pack",
          "-v",
          path.join(packDirectory, index),
        ]);
        if (objects.stdout.toString().includes(guestHead)) {
          continue;
        }
        await fs.rm(path.join(packDirectory, pack));
        await fs.rm(path.join(packDirectory, index));
      }
      const absent = await runGit(projection, ["cat-file", "-e", missingDonorBlob]);
      expect(absent.code).not.toBe(0);
      expect(await guestGit("rev-parse", `${baseCommit}^{tree}`)).not.toBe("");
    }
    return await runShellCommand(command);
  });
  const beforeLoss = reviewTransferBytes.length;
  expect(await refresh()).toMatchObject({ status: "current" });
  donorLoss.mockRestore();
  expect(removedRetained).toBe(true);
  expect(reviewTransferBytes.slice(beforeLoss)).toHaveLength(2);
  expect(reviewTransferBytes.at(-1)).toBeGreaterThan(64);
  expect(await guestGit("show", `${baseCommit}:later-upstream.txt`)).toBe("later upstream only");
  expect(await guestGit("rev-parse", "HEAD")).toBe(guestHead);

  await git("checkout", "main");
  await write(cwd, "retry-upstream.txt", "import retry\n");
  await git("add", "retry-upstream.txt");
  await git("commit", "-m", "Advance before interrupted review import");
  baseCommit = await git("rev-parse", "HEAD");
  await git("checkout", first.branch);

  // A lost acknowledgment after real import must reuse the installed target.
  const importInterruption = shellSpy().mockImplementation(async (command) => {
    const result = await runShellCommand(command);
    if (command.stdin) {
      expect(result.code).toBe(0);
      throw new Error("interrupted after review-base import");
    }
    return result;
  });
  await expect(refresh()).rejects.toThrow("interrupted after review-base import");
  importInterruption.mockRestore();
  expect(await refresh()).toMatchObject({ status: "current" });
  expect(reviewTransferBytes.at(-1)).toBeLessThanOrEqual(64);
  expect(await guestGit("show", `${baseCommit}:retry-upstream.txt`)).toBe("import retry");
  expect(await guestGit("rev-parse", "HEAD")).toBe(guestHead);
  expect(contentFetches).toBe(3);
  expect(await missingContents(ancestorCommit)).not.toContain("?");
  expect(await missingContents()).not.toContain("?");
  const transfersBeforeRevocation = reviewTransferBytes.length;
  let revokedAfterProbe = false;
  const revokeDuringProbe = shellSpy().mockImplementationOnce(async (command) => {
    expect(command.stdin).toBeUndefined();
    const result = await runShellCommand(command);
    expect(result.code).toBe(0);
    await f.revoke();
    revokedAfterProbe = true;
    return result;
  });
  await expect(refresh()).rejects.toThrow();
  expect(revokedAfterProbe).toBe(true);
  expect(revokeDuringProbe).toHaveBeenCalledTimes(1);
  expect(reviewTransferBytes).toHaveLength(transfersBeforeRevocation);
  revokeDuringProbe.mockRestore();
  await expect(refresh()).rejects.toThrow();
});
