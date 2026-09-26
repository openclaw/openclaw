// Rollback boundary for an adoption whose config commit never landed.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  mergeWorkspaceSetupState,
  readWorkspaceStateSnapshot,
} from "../agents/workspace-state-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { releaseUncommittedAgentAdoption } from "./add-adoption-release.js";
import type { ClawAddApplyOptions, ClawAddResult } from "./add-contract.js";
import { persistClawInstallRecord, type PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";
import { prepareClawBootstrapPublication, readClawWorkspaceAdoption } from "./workspace-origin.js";
import {
  CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
  type PersistedClawWorkspaceFile,
} from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function ownedFile(workspace: string, path: string, content: string): PersistedClawWorkspaceFile {
  return {
    schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
    agentId: "worker",
    workspace,
    path,
    sourcePath: path,
    contentDigest: digest(content),
    status: "complete",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function installRecord(workspace: string, bootstrapContent?: string): PersistedClawInstall {
  return {
    schemaVersion: "openclaw.clawInstallRecord.v3",
    claw: {
      kind: "package",
      name: "@acme/worker",
      version: "1.0.0",
      packageRoot: workspace,
      manifestPath: join(workspace, "openclaw.claw.json"),
      integrityKind: "artifact",
      integrity: "sha256:manifest",
      byteLength: 1,
    },
    manifestSchemaVersion: 1,
    planIntegrity: "sha256:plan",
    agentId: "worker",
    workspace,
    agentConfigDigest: "sha256:agent",
    agentOwnedPaths: [],
    agentOrigin: "adopted",
    status: "workspace_ready",
    addedAtMs: 1,
    updatedAtMs: 1,
    ...(bootstrapContent
      ? { bootstrap: { sourcePath: "BOOTSTRAP.md", contentDigest: digest(bootstrapContent) } }
      : {}),
  } as PersistedClawInstall;
}

function planWith(workspace: string, actions: ClawAddPlan["actions"]): ClawAddPlan {
  return {
    manifestSchemaVersion: 1,
    planIntegrity: "sha256:plan",
    claw: installRecord(workspace).claw,
    agent: { requestedId: "worker", finalId: "worker", workspace, config: { workspace } },
    actions,
  } as unknown as ClawAddPlan;
}

async function release(params: {
  plan: ClawAddPlan;
  install: PersistedClawInstall;
  workspaceFiles?: PersistedClawWorkspaceFile[];
  rollbackWorkspaceEffects?: boolean;
  options: ClawAddApplyOptions;
}): Promise<ClawAddResult> {
  return await releaseUncommittedAgentAdoption({
    plan: params.plan,
    install: params.install,
    workspaceFiles: params.workspaceFiles ?? [],
    packages: [],
    workspaceCreated: false,
    configCommitted: false,
    rollbackWorkspaceEffects: params.rollbackWorkspaceEffects ?? true,
    error: { code: "config_commit_failed", message: "Config commit failed." },
    options: params.options,
  });
}

function expectReleased(result: ClawAddResult): void {
  expect(result).toMatchObject({
    status: "partial",
    workspaceCreated: false,
    configCommitted: false,
    workspaceFiles: [],
    packages: [],
    error: { code: "config_commit_failed" },
  });
  expect(result.installRecord).toBeUndefined();
  expect(result.error?.message).toContain("released its unclaimed adoption");
}

describe("releaseUncommittedAgentAdoption", () => {
  it("keeps a declared file the attempt adopted instead of writing", async () => {
    const root = tempDirs.make("openclaw-claw-release-adopted-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const adopted = join(workspace, "SKILL.md");
    await writeFile(adopted, "operator content");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };

    const result = await release({
      plan: planWith(workspace, [
        {
          kind: "workspaceFile",
          id: "SKILL.md",
          action: "adopt",
          target: adopted,
          blocked: false,
        },
      ] as ClawAddPlan["actions"]),
      install: installRecord(workspace),
      workspaceFiles: [ownedFile(workspace, "SKILL.md", "operator content")],
      options: { env },
    });

    expectReleased(result);
    // The attempt claimed this file, it never wrote it; releasing the claim must not delete it.
    expect(existsSync(adopted)).toBe(true);
  });

  it("clears a prior attempt's seed marker with the bootstrap it rolls back", async () => {
    const root = tempDirs.make("openclaw-claw-release-bootstrap-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const bootstrap = join(workspace, "BOOTSTRAP.md");
    await writeFile(bootstrap, "seeded bootstrap");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    await mergeWorkspaceSetupState(workspace, { bootstrapSeededAt: new Date(1).toISOString() }, 1, {
      env,
    });

    const result = await release({
      plan: planWith(workspace, [] as ClawAddPlan["actions"]),
      install: installRecord(workspace, "seeded bootstrap"),
      options: { env, nowMs: 2 },
    });

    expectReleased(result);
    expect(existsSync(bootstrap)).toBe(false);
    // A marker left behind makes the next seed read "already seeded, file gone" as consumed and
    // silently skip the retry's bootstrap.
    expect(
      (await readWorkspaceStateSnapshot(workspace, { env })).setup.bootstrapSeededAt,
    ).toBeUndefined();
  });

  it("clears the seed marker when the receipt-owned bootstrap is already absent", async () => {
    const root = tempDirs.make("openclaw-claw-release-missing-bootstrap-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    await mergeWorkspaceSetupState(workspace, { bootstrapSeededAt: new Date(1).toISOString() }, 1, {
      env,
    });

    const result = await release({
      plan: planWith(workspace, [] as ClawAddPlan["actions"]),
      install: installRecord(workspace, "seeded bootstrap"),
      options: { env, nowMs: 2 },
    });

    expectReleased(result);
    expect(
      (await readWorkspaceStateSnapshot(workspace, { env })).setup.bootstrapSeededAt,
    ).toBeUndefined();
  });

  it("retains a byte-identical bootstrap replacement outside the publication receipt", async () => {
    const root = tempDirs.make("openclaw-claw-release-bootstrap-replacement-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const content = "seeded bootstrap";
    const bootstrap = join(workspace, "BOOTSTRAP.md");
    await writeFile(bootstrap, content);
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const plan = planWith(workspace, [
      {
        kind: "agent",
        id: "worker",
        action: "adopt",
        target: "agents.entries.worker",
        blocked: false,
      },
      {
        kind: "workspace",
        id: workspace,
        action: "adopt",
        target: workspace,
        blocked: false,
      },
      {
        kind: "bootstrap",
        id: "BOOTSTRAP.md",
        action: "write",
        target: bootstrap,
        digest: digest(content),
        details: { sourcePath: "BOOTSTRAP.md" },
        blocked: false,
      },
    ] as ClawAddPlan["actions"]);
    const install = persistClawInstallRecord(plan, { env, status: "workspace_ready", nowMs: 1 });
    const publisher = prepareClawBootstrapPublication(plan, { env, nowMs: 1 });
    if (!publisher) {
      throw new Error("expected an adopted bootstrap publisher");
    }
    const directoryPath = realpathSync(workspace);
    const directory = lstatSync(directoryPath, { bigint: true });
    const published = lstatSync(bootstrap, { bigint: true });
    const receipt = {
      directoryPath,
      directoryDev: directory.dev.toString(),
      directoryIno: directory.ino.toString(),
      dev: published.dev.toString(),
      ino: published.ino.toString(),
      birthtimeNs: published.birthtimeNs.toString(),
    };
    publisher.beforePublish(receipt);
    publisher.afterPublish(receipt);
    await mergeWorkspaceSetupState(workspace, { bootstrapSeededAt: new Date(1).toISOString() }, 1, {
      env,
    });

    const replacement = join(workspace, "BOOTSTRAP.replacement.md");
    await writeFile(replacement, content);
    const replacementIdentity = lstatSync(replacement, { bigint: true });
    expect(replacementIdentity.ino).not.toBe(published.ino);
    await unlink(bootstrap);
    await rename(replacement, bootstrap);

    const result = await release({ plan, install, options: { env, nowMs: 2 } });

    expect(result.installRecord).toBeDefined();
    expect(result.error?.message).toContain("still owns BOOTSTRAP.md");
    expect(existsSync(bootstrap)).toBe(true);
    expect((await readWorkspaceStateSnapshot(workspace, { env })).setup.bootstrapSeededAt).toBe(
      new Date(1).toISOString(),
    );
    expect(readClawWorkspaceAdoption("worker", workspace, { env })).toMatchObject({
      adopted: true,
      bootstrapPublication: receipt,
    });
  });

  it("leaves workspace state untouched when only pre-file package effects are released", async () => {
    const root = tempDirs.make("openclaw-claw-release-pre-files-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const bootstrap = join(workspace, "BOOTSTRAP.md");
    await writeFile(bootstrap, "existing bootstrap");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    await mergeWorkspaceSetupState(workspace, { bootstrapSeededAt: new Date(1).toISOString() }, 1, {
      env,
    });

    const result = await release({
      plan: planWith(workspace, [] as ClawAddPlan["actions"]),
      install: installRecord(workspace, "existing bootstrap"),
      rollbackWorkspaceEffects: false,
      options: { env, nowMs: 2 },
    });

    expectReleased(result);
    expect(await readWorkspaceStateSnapshot(workspace, { env })).toMatchObject({
      setup: { bootstrapSeededAt: new Date(1).toISOString() },
    });
    expect(existsSync(bootstrap)).toBe(true);
  });
});
