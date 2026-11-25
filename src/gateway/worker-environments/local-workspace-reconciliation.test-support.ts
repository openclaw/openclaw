import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { proveResumedBaseRefresh } from "./local-workspace-base-refresh.test-support.js";
import { prepareSandboxCheckpointFixture } from "./local-workspace-incremental.test-support.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

const writeText = (directory: string, relative: string, data: string) =>
  fs.writeFile(path.join(directory, relative), data);
const expectText = async (directory: string, relative: string, expected: string) =>
  expect(await fs.readFile(path.join(directory, relative), "utf8")).toBe(expected);

export function registerLocalWorkspaceReconciliationTests(
  fixture: () => Omit<Parameters<typeof proveResumedBaseRefresh>[0], "log">,
  log: Mock<(message: string) => void>,
) {
  it.each([false, true])(
    "probes after pending projection settlement before recapturing (guest edit: %s)",
    (guestEdit) => proveProjectionSettlementCapture(fixture().owner, guestEdit),
  );
  it("resumes an interrupted base refresh without persisting unused rollback packs", () =>
    proveRefreshRollbackPackElision({ ...fixture(), log }));
}

async function proveProjectionSettlementCapture(owner: LocalWorkspaceOwner, guestEdit: boolean) {
  using first = await prepareSandboxCheckpointFixture(owner);
  const worker = await import("./workspace-manifest-worker.js");
  const patch = vi.spyOn(worker, "prepareWorkspacePatch");
  patch.mockRejectedValueOnce(new Error("interrupted before projection apply"));
  await writeText(owner.worktree.path, "source.txt", "incoming host update\n");
  await expect(
    withLocalWorkspaceProjection(owner, (state) => state.synchronize("projection")),
  ).rejects.toThrow("interrupted before projection apply");
  patch.mockRestore();
  if (guestEdit) {
    await writeText(first.workspaceDir, "notes.txt", "independent guest edit\n");
  }
  const stores = await import("./local-workspace-store.js");
  const withStore = stores.withLocalWorkspaceStore;
  let captures = 0;
  vi.spyOn(stores, "withLocalWorkspaceStore").mockImplementation((params, run) =>
    withStore(params, (store) =>
      run({
        ...store,
        manifest: (row, action) => {
          if (action.kind === "scan" && action.target === "canonical") {
            captures++;
          }
          return store.manifest(row, action);
        },
      }),
    ),
  );
  using next = await prepareSandboxCheckpointFixture(owner);
  await expectText(next.workspaceDir, "source.txt", "incoming host update\n");
  if (guestEdit) {
    await expectText(owner.worktree.path, "notes.txt", "independent guest edit\n");
    await expectText(next.workspaceDir, "notes.txt", "independent guest edit\n");
  }
  expect(captures).toBe(guestEdit ? 1 : 0);
}

async function proveRefreshRollbackPackElision(
  params: Parameters<typeof proveResumedBaseRefresh>[0],
) {
  const { owner } = params;
  const packs: number[] = [];
  const manifest = await import("./workspace-manifest.js");
  const serialize = manifest.serializeWorkerWorkspaceReconciliationPlan;
  vi.spyOn(manifest, "serializeWorkerWorkspaceReconciliationPlan").mockImplementation((journal) => {
    packs.push(journal.basePack.byteLength);
    return serialize(journal);
  });
  using projection = await prepareSandboxCheckpointFixture(owner);
  const registry = await import("../../agents/sandbox/registry.js");
  const engine = await import("../../agents/sandbox/container-engine.js");
  const worker = await import("./workspace-manifest-worker.js");
  const containerName = `projection-refresh-${randomUUID()}`;
  let paused = false;
  vi.spyOn(engine, "execContainer").mockImplementation(async (_engine, args) => {
    let stdout = "";
    if (args[0] === "info") {
      stdout = "refresh-daemon";
    } else if (args[0] === "inspect") {
      stdout = args.includes("{{.State.Paused}}")
        ? String(paused)
        : `${"a".repeat(64)} true ${paused}`;
    } else if (args[0] === "pause") {
      paused = true;
    } else if (args[0] === "unpause") {
      paused = false;
    }
    return { code: 0, stdout, stderr: "" };
  });
  const preparePatch = worker.prepareWorkspacePatch;
  const patchPauses: boolean[] = [];
  vi.spyOn(worker, "prepareWorkspacePatch").mockImplementation((input) => {
    patchPauses.push(paused);
    return preparePatch(input);
  });
  await registry.updateRegistry({
    containerName,
    backendId: "docker",
    sessionKey: owner.sessionKey,
    workspaceDir: projection.workspaceDir,
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "fixture",
  });
  try {
    await proveResumedBaseRefresh(params);
    expect(packs).toEqual([]);
    expect(patchPauses).toEqual([false, false]);
    expect(paused).toBe(false);
  } finally {
    await registry.removeRegistryEntry(containerName);
  }
}
