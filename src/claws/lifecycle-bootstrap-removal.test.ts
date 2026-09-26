// Removal must retain the original descriptor across staging without relaxing durable ownership.
import { createHash } from "node:crypto";
import syncFs from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { seedWorkspaceBootstrap } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/config.js";
import * as fsSafe from "../infra/fs-safe.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { seedClawPackageBootstrap } from "./bootstrap.js";
import { removeClawBootstrap } from "./lifecycle-bootstrap-removal.js";
import { readClawStatus } from "./lifecycle-status.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { deleteClawInstallRecord, persistClawInstallRecord } from "./provenance.js";
import { stateEnv } from "./provenance.test-helpers.js";
import { parseClawManifest } from "./schema.js";
import { prepareClawBootstrapPublication, readClawWorkspaceAdoption } from "./workspace-origin.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

async function adoptedBootstrapPlan() {
  const root = tempDirs.make("openclaw-bootstrap-removal-pin-");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const content = Buffer.from("Package bootstrap\n");
  const sourcePath = join(root, "BOOTSTRAP.md");
  await writeFile(sourcePath, content);
  const manifest = parseClawManifest({ schemaVersion: 1, agent: { id: "worker" } });
  if (!manifest.ok) {
    throw new Error(JSON.stringify(manifest.diagnostics));
  }
  const plan = await buildClawAddPlan({
    manifest: manifest.manifest,
    source: {
      kind: "package",
      name: "@acme/worker",
      version: "1.0.0",
      packageRoot: root,
      manifestPath: join(root, "openclaw.claw.json"),
      integrityKind: "development-snapshot",
      integrity: "sha256:test",
      byteLength: 0,
    },
    packageBootstrap: {
      sourcePath: "BOOTSTRAP.md",
      realPath: sourcePath,
      byteLength: content.byteLength,
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    },
    context: { workspace, adoptExistingWorkspace: true },
  });
  expect(plan.blockers).toEqual([]);
  return { plan, env: stateEnv(root), content, workspace: plan.agent.workspace };
}

async function adoptedBootstrapFixture() {
  const { plan, env, content } = await adoptedBootstrapPlan();
  let config: OpenClawConfig = {};
  const added = await applyClawAddPlan(plan, {
    consentPlanIntegrity: plan.planIntegrity,
    env,
    commitConfig: async (transform) => {
      config = transform(config);
    },
  });
  expect(added.status).toBe("complete");
  const status = await readClawStatus("worker", { env, config });
  const record = status.records[0];
  if (!record) {
    throw new Error("expected installed Claw status");
  }
  expect(record.bootstrap.state).toBe("pending");
  expect(record.workspaceOrigin).toMatchObject({ adopted: true, bootstrapSeeded: true });
  return { workspace: plan.agent.workspace, content, record };
}

describe("adopted bootstrap descriptor-bound removal", () => {
  it.each([
    "original",
    "helper-unavailable",
    "replacement",
    "stale-receipt",
    "modified-after-read",
    "modified-size",
    "modified-mtime",
  ] as const)(
    "preserves descriptor-bound ownership for %s across removal staging",
    async (entry) => {
      let birthtimeNs = 101n;
      const realFstat = syncFs.fstatSync.bind(syncFs);
      // Keep all physical metadata real except the unsupported creation-time observation.
      const statSpy = vi.spyOn(syncFs, "fstatSync").mockImplementation((fd, options) => {
        if (options?.bigint) {
          const observed = realFstat(fd, { bigint: true });
          if (observed.isFile()) {
            observed.birthtimeNs = birthtimeNs;
          }
          return observed;
        }
        return realFstat(fd, options);
      });
      const realRoot = fsSafe.root;
      let staged = false;
      let replaced = false;
      let edited: Buffer | undefined;
      let restoreRoot: () => void = () => undefined;
      const restoreOperations: (() => void)[] = [];
      try {
        const { workspace, content, record } = await adoptedBootstrapFixture();
        if (entry === "modified-after-read") {
          syncFs.utimesSync(join(workspace, "BOOTSTRAP.md"), new Date(0), new Date(2_000));
        }
        const originalPath = join(workspace, "original.md");
        const rootSpy = vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
          const opened = await realRoot(...args);
          if (opened.rootReal === syncFs.realpathSync(workspace)) {
            const move = opened.move.bind(opened);
            const moveSpy = vi.spyOn(opened, "move").mockImplementation(async (...moveArgs) => {
              const [from, to, options] = moveArgs;
              if (
                from === "BOOTSTRAP.md" ||
                from.startsWith("BOOTSTRAP.md.openclaw-claw-remove-")
              ) {
                if (entry === "helper-unavailable" && from === "BOOTSTRAP.md") {
                  throw new fsSafe.FsSafeError(
                    "helper-unavailable",
                    "native no-replace move is unavailable",
                  );
                }
                options?.assertBeforeMutation?.();
                const fromPath = join(workspace, from);
                const toPath = join(workspace, to);
                if (syncFs.existsSync(toPath)) {
                  throw new Error(`test no-replace target already exists: ${to}`);
                }
                syncFs.renameSync(fromPath, toPath);
              } else {
                await move(...moveArgs);
              }
              if (to.startsWith("BOOTSTRAP.md.openclaw-claw-remove-")) {
                staged = true;
                birthtimeNs = 202n;
              }
            });
            restoreOperations.push(() => moveSpy.mockRestore());
            const readBytes = opened.readBytes.bind(opened);
            const readBytesSpy = vi
              .spyOn(opened, "readBytes")
              .mockImplementation(async (...readArgs) => {
                const bytes = await readBytes(...readArgs);
                if (
                  entry === "modified-after-read" &&
                  readArgs[0].startsWith("BOOTSTRAP.md.openclaw-claw-remove-") &&
                  !edited
                ) {
                  const target = join(workspace, readArgs[0]);
                  const beforeEdit = syncFs.statSync(target);
                  edited = Buffer.alloc(content.length, 0x79);
                  syncFs.writeFileSync(target, edited);
                  syncFs.utimesSync(target, beforeEdit.atime, beforeEdit.mtime);
                }
                return bytes;
              });
            restoreOperations.push(() => readBytesSpy.mockRestore());
            const remove = opened.remove.bind(opened);
            const removeSpy = vi
              .spyOn(opened, "remove")
              .mockImplementation(async (...removeArgs) => {
                // remove is entered after the staged file's digest was checked. Change that
                // same object before fs-safe admits unlink, without replacing its inode.
                if ((entry === "modified-size" || entry === "modified-mtime") && !edited) {
                  const target = join(workspace, removeArgs[0]);
                  edited =
                    entry === "modified-size"
                      ? Buffer.concat([content, Buffer.from("operator edit\n")])
                      : Buffer.alloc(content.length, 0x78);
                  syncFs.writeFileSync(target, edited);
                  syncFs.utimesSync(target, new Date(0), new Date(2_000));
                  birthtimeNs = 303n;
                }
                if (entry === "replacement" && !replaced) {
                  replaced = true;
                  const target = join(workspace, removeArgs[0]);
                  syncFs.renameSync(target, originalPath);
                  syncFs.writeFileSync(target, content);
                }
                return await remove(...removeArgs);
              });
            restoreOperations.push(() => removeSpy.mockRestore());
          }
          return opened;
        });
        restoreRoot = () => rootSpy.mockRestore();
        if (entry === "stale-receipt") {
          birthtimeNs = 303n;
        }
        const removed = await removeClawBootstrap(record, () => undefined);
        if (entry === "stale-receipt") {
          expect(removed).toEqual({ path: "BOOTSTRAP.md", action: "retainedUnowned" });
          expect(staged).toBe(false);
          expect(await readFile(join(workspace, "BOOTSTRAP.md"))).toEqual(content);
          expect(await readdir(workspace)).toEqual(["BOOTSTRAP.md"]);
          return;
        }
        expect(staged).toBe(entry !== "helper-unavailable");
        if (entry === "original" || entry === "helper-unavailable") {
          expect(removed).toEqual({ path: "BOOTSTRAP.md", action: "deleted" });
          expect(await readdir(workspace)).toEqual([]);
        } else if (entry === "modified-after-read") {
          expect(edited).toBeDefined();
          expect(removed).toEqual({ path: "BOOTSTRAP.md", action: "retainedModified" });
          expect(await readFile(join(workspace, "BOOTSTRAP.md"))).toEqual(edited);
          expect(await readdir(workspace)).toEqual(["BOOTSTRAP.md"]);
        } else if (entry === "modified-size" || entry === "modified-mtime") {
          expect(edited).toBeDefined();
          expect(removed).toMatchObject({ path: "BOOTSTRAP.md", action: "error" });
          expect(await readFile(join(workspace, "BOOTSTRAP.md"))).toEqual(edited);
          expect(await readdir(workspace)).toEqual(["BOOTSTRAP.md"]);
        } else {
          expect(replaced).toBe(true);
          expect(removed).toMatchObject({ path: "BOOTSTRAP.md", action: "error" });
          expect(await readFile(join(workspace, "BOOTSTRAP.md"))).toEqual(content);
          expect(await readFile(originalPath)).toEqual(content);
          expect(syncFs.statSync(join(workspace, "BOOTSTRAP.md")).ino).not.toBe(
            syncFs.statSync(originalPath).ino,
          );
          expect((await readdir(workspace)).toSorted()).toEqual(["BOOTSTRAP.md", "original.md"]);
        }
      } finally {
        restoreRoot();
        for (const restore of restoreOperations) {
          restore();
        }
        statSpy.mockRestore();
      }
    },
  );
});

describe("adopted bootstrap completion authority", () => {
  it.each(["checkpoint-failure", "revoked-install"] as const)(
    "leaves the published fallback object unowned after %s",
    async (boundary) => {
      const { plan, env, content, workspace } = await adoptedBootstrapPlan();
      persistClawInstallRecord(plan, { env, status: "workspace_ready", nowMs: 1_000 });
      const publication = prepareClawBootstrapPublication(plan, { env });
      if (!publication) {
        throw new Error("expected an adopted publisher");
      }
      let birthtimeNs = 101n;
      const realFstat = syncFs.fstatSync.bind(syncFs);
      const statSpy = vi.spyOn(syncFs, "fstatSync").mockImplementation((fd, options) => {
        if (options?.bigint) {
          const observed = realFstat(fd, { bigint: true });
          if (observed.isFile()) {
            observed.birthtimeNs = birthtimeNs;
          }
          return observed;
        }
        return realFstat(fd, options);
      });
      const realUnlink = syncFs.unlinkSync.bind(syncFs);
      const unlinkSpy = vi.spyOn(syncFs, "unlinkSync").mockImplementation((filePath) => {
        realUnlink(filePath);
        if (String(filePath).endsWith("BOOTSTRAP.md")) {
          birthtimeNs = 202n;
        }
      });
      const beforePublish = vi.fn(publication.beforePublish);
      const afterPublish = vi.fn((identity: Parameters<typeof publication.afterPublish>[0]) => {
        expect(identity.birthtimeNs).toBe("202");
        if (boundary === "checkpoint-failure") {
          throw new Error("checkpoint unavailable");
        }
        deleteClawInstallRecord(plan.agent.finalId, { env });
        persistClawInstallRecord(plan, { env, status: "workspace_ready", nowMs: 1_000 });
        publication.afterPublish(identity);
      });
      try {
        await expect(
          seedWorkspaceBootstrap({
            dir: workspace,
            content,
            stateOptions: { env },
            existingFile: "conflict",
            ...publication,
            beforePublish,
            afterPublish,
          }),
        ).rejects.toThrow(
          boundary === "checkpoint-failure"
            ? "checkpoint unavailable"
            : "Claw install changed before bootstrap publication",
        );
        expect(afterPublish).toHaveBeenCalledTimes(1);
        expect(await readFile(join(workspace, "BOOTSTRAP.md"))).toEqual(content);
        expect(
          (await readWorkspaceStateSnapshot(workspace, { env })).setup.bootstrapSeededAt,
        ).toBeUndefined();
        const origin = readClawWorkspaceAdoption("worker", workspace, { env });
        expect(origin).toMatchObject({ adopted: true, bootstrapSeeded: false });
        if (!origin.adopted) {
          throw new Error("expected adopted workspace");
        }
        expect(beforePublish).toHaveBeenCalledTimes(1);
        expect(origin.bootstrapPublication).toEqual(
          boundary === "checkpoint-failure" ? beforePublish.mock.calls[0]?.[0] : undefined,
        );
        // A new attempt must use the durable receipt, not reconstruct a claim from matching bytes.
        await expect(seedClawPackageBootstrap(plan, { env })).rejects.toMatchObject({
          code: "bootstrap_conflict",
        });
      } finally {
        unlinkSpy.mockRestore();
        statSpy.mockRestore();
      }
    },
  );
});
