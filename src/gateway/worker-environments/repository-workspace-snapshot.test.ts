import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as processExec from "../../process/exec.js";
import { openDiskCleanupTransport } from "./placement-disk-cleanup.test-support.js";
import { writePlacementEnvironmentFixture } from "./placement-test-fixtures.js";
import { captureRepositoryDiskCheckpoint } from "./repository-workspace-snapshot.js";
import { openRepositoryCaptureTransport } from "./repository-workspace-snapshot.test-support.js";
import {
  forkSessionRepositoryWorkspace,
  readSessionRepositoryArtifacts,
  withSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import { database, placements, sessionTarget } from "./worker-turn-launcher.test-support.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";
import {
  hasWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

// mock-isolation: Real node/Git/HTTP transfer uses a local origin with no GitHub credentials.
vi.mock("./repository-github-identity.js", () => ({
  prepareRepositoryGitHubIdentity: async (_agentId: string, assertCurrent: () => void) => ({
    token: undefined,
    assertSelected: assertCurrent,
    start: async (start: () => Promise<unknown>) => await start(),
  }),
}));
const { fixture } = useRepositoryWorkspaceResultFixture();

it("exports current private history and files, then fences a late source edit before handoff", async () => {
  const f = await fixture("worker-turn");
  const repository = await f.bindDisk();
  await f.write("committed.txt", "private committed bytes\n");
  await requireWorkspaceResultGit(f.remote, ["add", "committed.txt"]);
  await requireWorkspaceResultGit(f.remote, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "private node history",
  ]);
  const head = await requireWorkspaceResultGit(f.remote, ["rev-parse", "HEAD"]);
  await f.write("working.txt", "current uncommitted bytes\n");
  const quiescence = await f.tunnel.quiesceWorkspace(f.remote);
  try {
    await captureRepositoryDiskCheckpoint(
      {
        identity: sessionTarget,
        repository,
        checkpointRef: workerWorkspaceResultRef("fresh-export"),
        purpose: "gateway-move",
        quiescence,
        placements: f.placements,
        environments: f.environments,
        assertCurrent() {},
      },
      async (snapshot, verifyCurrent) => {
        await withSessionRepositoryCheckpoint(
          { workspaceId: repository.workspaceId, checkpointRef: snapshot.checkpointRef },
          async (payload) => {
            expect(payload.gitHistory).toMatchObject({ headCommit: head, descendsFromBase: true });
            expect(payload.gitHistoryNote).toBeUndefined();
            expect(await fs.readFile(path.join(payload.stagingRoot, "working.txt"), "utf8")).toBe(
              "current uncommitted bytes\n",
            );
          },
        );
        await verifyCurrent();
        await f.write("working.txt", "changed after export selection\n");
        await expect(verifyCurrent()).rejects.toThrow("changed during checkpoint capture");
      },
    );
  } finally {
    await quiescence.resume();
  }
  expect(await f.store.get(repository.workspaceId)).toEqual(repository);
  expect(await requireWorkspaceResultGit(f.remote, ["rev-parse", "HEAD"])).toBe(head);
});

it("refuses a lossy staged-index export while retaining the original disk", async () => {
  const f = await fixture("worker-turn");
  const repository = await f.bindDisk();
  await f.write("partial.txt", "staged-only content\n");
  await requireWorkspaceResultGit(f.remote, ["add", "partial.txt"]);
  await f.write("partial.txt", "different working content\n");
  const upload = vi.spyOn(f.workspaceTransfer, "prepareUpload");
  const quiescence = await f.tunnel.quiesceWorkspace(f.remote);
  try {
    await expect(
      captureRepositoryDiskCheckpoint(
        {
          identity: sessionTarget,
          repository,
          checkpointRef: workerWorkspaceResultRef("partial-export"),
          purpose: "gateway-move",
          quiescence,
          placements: f.placements,
          environments: f.environments,
          assertCurrent() {},
        },
        async () => {},
      ),
    ).rejects.toThrow("resolve staged changes");
  } finally {
    await quiescence.resume();
  }
  expect(upload).not.toHaveBeenCalled();
  expect(await requireWorkspaceResultGit(f.remote, ["show", ":partial.txt"])).toBe(
    "staged-only content",
  );
  expect(await fs.readFile(path.join(f.remote, "partial.txt"), "utf8")).toBe(
    "different working content\n",
  );
  expect(await f.store.get(repository.workspaceId)).toEqual(repository);
});

describe("new capture through native private transport", () => {
  let wire: Awaited<ReturnType<typeof openDiskCleanupTransport>>;
  let beforePairing = async () => {};
  beforeAll(async () => {
    // Configured synthetic pairing, not a login/enrollment or cloud allocation claim.
    wire = await openDiskCleanupTransport({
      resolveCurrentPairingState: async () => {
        await beforePairing();
        return { identity: "disk-cleanup-pairing", generation: "disk-cleanup-generation" };
      },
    });
  });
  afterAll(async () => {
    await wire.close();
  });

  it("shares a retained capture with requests queued after receipt binding fails", async () => {
    const f = await openRepositoryCaptureTransport(wire);
    const checkpointRef = workerWorkspaceResultRef("retained-request");
    const alias = workerWorkspaceResultRef("queued-after-capture");
    let current = true;
    const params = {
      identity: sessionTarget,
      repository: f.repository,
      checkpointRef,
      purpose: "publication" as const,
      placements,
      environments: f.environments,
      assertCurrent() {
        if (!current) {
          throw new Error("retained requester revoked");
        }
      },
    };
    try {
      await fs.writeFile(path.join(f.remote, "captured.txt"), "original captured bytes\n");
      await expect(
        captureRepositoryDiskCheckpoint(params, async () => {
          throw new Error("receipt binding lost");
        }),
      ).rejects.toThrow("receipt binding lost");
      const events = [...f.events];
      await fs.writeFile(path.join(f.remote, "captured.txt"), "later disk bytes\n");
      const run = processExec.runCommandWithTimeout;
      const runner = vi
        .spyOn(processExec, "runCommandWithTimeout")
        .mockImplementation((argv, options) => {
          if (
            argv.includes("update-ref") &&
            typeof options !== "number" &&
            options.input?.toString().includes("create " + alias + "\0")
          ) {
            const beforeInput = options.beforeInput;
            assert(beforeInput);
            return run(argv, {
              ...options,
              beforeInput: (...args) => {
                current = false;
                beforeInput(...args);
              },
            });
          }
          return run(argv, options);
        });
      try {
        await expect(
          captureRepositoryDiskCheckpoint({ ...params, additionalRefs: [alias] }, async () => {}),
        ).rejects.toThrow("retained requester revoked");
      } finally {
        runner.mockRestore();
        current = true;
      }
      expect(
        await hasWorkerWorkspaceResultRef({
          root: f.store.artifactPath(f.repository.workspaceId),
          stagedResultRef: alias,
        }),
      ).toBe(false);
      await captureRepositoryDiskCheckpoint({ ...params, additionalRefs: [alias] }, async () => {});
      expect(
        await hasWorkerWorkspaceResultRef({
          root: f.store.artifactPath(f.repository.workspaceId),
          stagedResultRef: alias,
        }),
      ).toBe(true);
      await captureRepositoryDiskCheckpoint(
        { ...params, checkpointRef: alias, additionalRefs: [checkpointRef] },
        async (snapshot) => {
          await withSessionRepositoryCheckpoint(
            { workspaceId: f.repository.workspaceId, checkpointRef: snapshot.checkpointRef },
            async (payload) => {
              expect(payload.publicationDigest).toMatch(/^sha256:/);
              expect(payload.publicationStagingRoot).toBeDefined();
              expect(
                await fs.readFile(path.join(payload.stagingRoot, "captured.txt"), "utf8"),
              ).toBe("original captured bytes\n");
            },
          );
        },
      );
      expect(f.events).toEqual(events);
      expect(f.workspace.quiescence.hasActiveWork()).toBe(false);
      expect(await f.store.get(f.repository.workspaceId)).toEqual(f.repository);
    } finally {
      await f.close();
    }
  });

  it("captures unchanged initialization files on the authoritative disk without reopening implicit reads", async () => {
    const f = await openRepositoryCaptureTransport(wire);
    const checkpointRef = workerWorkspaceResultRef("unchanged-disk-capture");
    const aliasRef = workerWorkspaceResultRef("unchanged-disk-alias");
    const source = { workspaceId: f.repository.workspaceId };
    try {
      const captured = await captureRepositoryDiskCheckpoint(
        {
          identity: sessionTarget,
          repository: f.repository,
          checkpointRef,
          additionalRefs: [aliasRef],
          purpose: "publication",
          placements,
          environments: f.environments,
          assertCurrent() {},
        },
        async (snapshot, verifyCurrent) => {
          await verifyCurrent();
          for (const ref of [checkpointRef, aliasRef]) {
            await withSessionRepositoryCheckpoint(
              { ...source, checkpointRef: ref },
              async (payload) => {
                expect(payload.current.entries).toEqual([]);
                expect(payload.publicationDigest).toMatch(/^sha256:/);
                expect(payload.publicationStagingRoot).toBeDefined();
              },
            );
          }
          return snapshot;
        },
      );
      expect(captured).toEqual({ checkpointRef, manifestHash: f.repository.manifestHash });
      expect(await requireWorkspaceResultGit(f.remote, ["rev-parse", "HEAD"])).toBe(
        f.repository.baseCommit,
      );
      await expect(withSessionRepositoryCheckpoint(source, async () => {})).rejects.toThrow(
        "fresh disk export",
      );
      await expect(
        readSessionRepositoryArtifacts({ ...source, assertCurrent() {} }),
      ).rejects.toThrow("fresh disk export");
      await expect(
        forkSessionRepositoryWorkspace({
          sourceWorkspaceId: f.repository.workspaceId,
          agentId: sessionTarget.agentId,
          sessionKey: "agent:main:unchanged-disk-fork",
          assertCurrent() {},
        }),
      ).rejects.toThrow("Fork requires a fresh disk export");
      expect(await f.store.get(f.repository.workspaceId)).toEqual(f.repository);
      expect(wire.errors).toEqual([]);
      expect(f.workspace.quiescence.hasActiveWork()).toBe(false);
    } finally {
      await f.close();
    }
  });

  it.for([
    { boundary: "build", change: "disk" },
    { boundary: "build", change: "session" },
    { boundary: "capability", change: "request" },
    { boundary: "final-input", change: "request" },
    { boundary: "final-input", change: "none" },
  ] as const)(
    "checks $change authority at $boundary with real transport",
    async ({ boundary, change }, { signal }) => {
      const f = await openRepositoryCaptureTransport(wire);
      const artifact = f.store.artifactPath(f.repository.workspaceId);
      const checkpointRef = workerWorkspaceResultRef("capture-wire-selected");
      const aliasRef = workerWorkspaceResultRef("capture-wire-alias");
      const refs = () =>
        requireWorkspaceResultGit(artifact, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/openclaw/",
        ]);
      const beforeRefs = await refs();
      await fs.writeFile(path.join(f.remote, "captured.txt"), "synthetic current disk bytes\n");
      const entered = createDeferred();
      const release = createDeferred();
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      const abort = () => release.resolve();
      signal.addEventListener("abort", abort, { once: true });
      let requestCurrent = true;
      let finalInputChecked = false;
      const consume = vi.fn(async (snapshot: { checkpointRef: string }) => {
        await withSessionRepositoryCheckpoint(
          { workspaceId: f.repository.workspaceId, checkpointRef: snapshot.checkpointRef },
          async (payload) => {
            expect(payload.publicationDigest).toMatch(/^sha256:/);
            expect(payload.publicationStagingRoot).toBeDefined();
            expect(await fs.readFile(path.join(payload.stagingRoot, "captured.txt"), "utf8")).toBe(
              "synthetic current disk bytes\n",
            );
          },
        );
      });
      const receive = f.transfer.receiveUpload.bind(f.transfer);
      let uploads = 0;
      vi.spyOn(f.transfer, "receiveUpload").mockImplementation(async (params) => {
        const result = await receive(params);
        uploads++;
        return result;
      });
      if (boundary === "build") {
        f.preparation.beforeBuild = pause;
      }
      if (boundary === "capability") {
        beforePairing = async () => {
          beforePairing = async () => {};
          await pause();
        };
      }
      const run = processExec.runCommandWithTimeout;
      const runner = vi
        .spyOn(processExec, "runCommandWithTimeout")
        .mockImplementation(async (argv, options) => {
          if (
            boundary === "final-input" &&
            argv.includes("update-ref") &&
            typeof options !== "number" &&
            options.input?.toString().includes("create " + checkpointRef + "\0")
          ) {
            await pause();
            const beforeInput = options.beforeInput;
            assert(beforeInput);
            return await run(argv, {
              ...options,
              beforeInput: (...args) => {
                finalInputChecked = true;
                beforeInput(...args);
              },
            });
          }
          return await run(argv, options);
        });
      const pending = captureRepositoryDiskCheckpoint(
        {
          identity: sessionTarget,
          repository: f.repository,
          checkpointRef,
          additionalRefs: [aliasRef],
          purpose: "publication",
          placements,
          environments: f.environments,
          assertCurrent() {
            if (!requestCurrent) {
              throw new Error("capture requester revoked");
            }
          },
        },
        consume,
      );
      void pending.catch(() => {});
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "Capture settled before the selected boundary",
          ),
          signal,
        );
        expect(
          await hasWorkerWorkspaceResultRef({ root: artifact, stagedResultRef: checkpointRef }),
        ).toBe(false);
        if (change === "request") {
          requestCurrent = false;
        }
        if (change === "disk" || change === "session") {
          // A nearest-neighbor durable fault preserves epoch and every other field.
          writePlacementEnvironmentFixture(database, {
            ...f.original,
            ...(change === "disk"
              ? {
                  resourceReceipt: {
                    ...f.repository.diskAuthority!.resourceReceipt,
                    identity: { diskId: "replacement-disk" },
                  },
                }
              : { attachedSessionIds: ["different-session"] }),
          });
        }
        release.resolve();
        if (change === "none") {
          await withinTest(pending, signal);
        } else {
          await expect(withinTest(pending, signal)).rejects.toThrow(
            change === "disk"
              ? "disk is missing or changed"
              : change === "session"
                ? "lost its exact session attachment"
                : "capture requester revoked",
          );
        }
        expect(wire.errors).toEqual([]);
        expect(f.workspace.quiescence.hasActiveWork()).toBe(false);
        const selected = await hasWorkerWorkspaceResultRef({
          root: artifact,
          stagedResultRef: checkpointRef,
        });
        const alias = await hasWorkerWorkspaceResultRef({
          root: artifact,
          stagedResultRef: aliasRef,
        });
        expect(selected).toBe(change === "none");
        expect(alias).toBe(selected);
        expect(consume).toHaveBeenCalledTimes(change === "none" ? 1 : 0);
        expect(await f.store.get(f.repository.workspaceId)).toEqual(f.repository);
        expect(await fs.readFile(path.join(f.remote, "captured.txt"), "utf8")).toBe(
          "synthetic current disk bytes\n",
        );
        if (boundary === "final-input") {
          expect(uploads).toBe(2);
          expect(finalInputChecked).toBe(true);
          expect(f.events).toContain("quiescence:acquire:ack");
          expect(f.events).toContain("quiescence:release:ack");
          expect(f.events.indexOf("repository-upload:ack")).toBeLessThan(
            f.events.indexOf("publication-upload:ack"),
          );
        } else {
          expect(wire.commands).toEqual([]);
          expect(uploads).toBe(0);
        }
        if (change !== "none") {
          expect(await refs()).toBe(beforeRefs);
        } else {
          expect(
            (await refs()).split("\n").filter((ref) => !beforeRefs.split("\n").includes(ref)),
          ).toHaveLength(4);
        }
        console.info(
          JSON.stringify({
            operation: "capture:" + boundary + ":" + change,
            status: selected ? "published" : "refused",
            selectedRefExists: selected,
            aliasRefExists: alias,
            transport: f.events
              .filter(
                (operation) =>
                  operation.endsWith(":ack") && !operation.startsWith("workspace-command:"),
              )
              .map((operation) => ({ operation, status: "acknowledged" })),
          }),
        );
      } finally {
        release.resolve();
        beforePairing = async () => {};
        signal.removeEventListener("abort", abort);
        await pending.catch(() => {});
        runner.mockRestore();
        await f.close();
      }
    },
  );
});
