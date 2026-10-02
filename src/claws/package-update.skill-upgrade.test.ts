import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import {
  readClawHubSkillOrigin,
  readClawHubSkillsLockfile,
} from "../skills/lifecycle/clawhub-store.js";
import { planClawHubSkillUninstall } from "../skills/lifecycle/clawhub-uninstall.js";
import { installSkillFromClawHub } from "../skills/lifecycle/clawhub.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { digestClawValue } from "./digest.js";
import { projectClawConfiguredAccess } from "./gateway-disclosure.js";
import { digestClawPackageRef } from "./package-update-provenance.js";
import { applyClawPackageUpdate } from "./package-update.js";
import { preflightClawPackage } from "./packages.js";
import {
  CLAW_PACKAGE_REF_SCHEMA_VERSION,
  persistClawInstallRecord,
  persistClawPackageRef,
  readClawInstallRecord,
  readClawPackageRefs,
  type PersistedClawPackageRef,
} from "./provenance.js";
import { createClawUpdatePlanFixture } from "./resource-update.test-helpers.js";
import { parseClawManifest } from "./schema.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan, type ClawOpenClawProfile } from "./types.js";
import { applyClawUpdatePlan, ClawUpdateMutationError } from "./update-apply.js";
import { buildClawUpdatePlan } from "./update-plan.js";

const registry = vi.hoisted(() => ({
  detail: vi.fn(),
  download: vi.fn(),
  verify: vi.fn(),
  telemetry: vi.fn(),
}));

vi.mock("../infra/clawhub-skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-skills.js")>()),
  fetchClawHubSkillDetail: registry.detail,
  fetchClawHubSkillVerification: registry.verify,
  reportClawHubSkillInstallTelemetry: registry.telemetry,
}));

vi.mock("../infra/clawhub-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-artifacts.js")>()),
  downloadClawHubSkillArchive: registry.download,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);

async function makeArchive(root: string, version: string) {
  const zip = new JSZip();
  const content = `---\nname: triage\ndescription: Triage incidents\nversion: ${version}\n---\n`;
  zip.file("SKILL.md", content);
  const bytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
  const archivePath = path.join(root, `triage-${version}.zip`);
  await fs.writeFile(archivePath, bytes);
  const sha256Hex = createHash("sha256").update(bytes).digest("hex");
  return {
    archivePath,
    content,
    integrity: normalizeClawHubSha256Integrity(`sha256:${sha256Hex}`)!,
    sha256Hex,
    artifact: "archive" as const,
    cleanup: async () => undefined,
  };
}

async function setup() {
  const root = tempDirs.make("openclaw-owned-skill-upgrade-");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const v1 = await makeArchive(root, "1.0.0");
  const v2 = await makeArchive(root, "2.0.0");
  registry.detail.mockImplementation(async () => ({
    skill: { slug: "triage", official: true },
    latestVersion: { version: "2.0.0", createdAt: 1 },
  }));
  registry.download.mockImplementation(async (params: { version: string }) =>
    params.version === "1.0.0" ? v1 : v2,
  );
  registry.verify.mockRejectedValue(new Error("verification unavailable"));
  registry.telemetry.mockResolvedValue(undefined);
  const added = await installSkillFromClawHub({
    workspaceDir: workspace,
    slug: "triage",
    version: "1.0.0",
    expectedIntegrity: v1.integrity,
    clawManaged: true,
  });
  if (!added.ok) {
    throw new Error(added.error);
  }
  const previous: PersistedClawPackageRef = {
    schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
    agentId: "worker",
    clawName: "@acme/worker",
    kind: "skill",
    source: "clawhub",
    ref: "triage",
    version: "1.0.0",
    integrity: v1.integrity,
    status: "complete",
    relationship: "managed",
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: Date.now() + 1_000,
    updatedAtMs: Date.now() + 1_000,
  };
  const skillDir = path.join(workspace, "skills", "triage");
  const oldLock = await readClawHubSkillsLockfile(workspace);
  const oldOrigin = await readClawHubSkillOrigin(skillDir);
  const action = {
    kind: "package" as const,
    id: "skill:triage",
    action: "change" as const,
    target: "clawhub:triage@2.0.0",
    blocked: false,
    reason: "Upgrade managed skill",
    currentDigest: digestClawPackageRef(previous),
  };
  const targetAddPlan: ClawAddPlan = {
    schemaVersion: "openclaw.clawAddPlan.v1",
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    manifestSchemaVersion: 1,
    planIntegrity: "sha256:test",
    claw: {
      kind: "package",
      name: "@acme/worker",
      version: "2.0.0",
      packageRoot: root,
      manifestPath: path.join(root, "openclaw.claw.json"),
      integrityKind: "artifact",
      integrity: v2.integrity,
      byteLength: 1,
    },
    agent: {
      requestedId: "worker",
      finalId: "worker",
      workspace,
      config: { id: "worker", workspace },
    },
    summary: {
      totalActions: 1,
      agentActions: 0,
      workspaceActions: 0,
      packageActions: 1,
      mcpServerActions: 0,
      cronJobActions: 0,
      blockedActions: 0,
      capabilityEscalations: 0,
    },
    actions: [
      {
        kind: "package",
        id: "skill:triage",
        action: "install",
        target: "clawhub:triage@2.0.0",
        blocked: false,
        details: {
          kind: "skill",
          source: "clawhub",
          ref: "triage",
          version: "2.0.0",
          integrity: v2.integrity,
          ownerAction: "install",
        },
      },
    ],
    capabilityChanges: [],
    blockers: [],
    diagnostics: [],
    readiness: { ready: true, requirements: [] },
  };
  let current: PersistedClawPackageRef | undefined = previous;
  const otherRefs: PersistedClawPackageRef[] = [];
  const options = {
    readRefs: async (query?: { agentId?: string }) =>
      [current, ...otherRefs].filter((candidate): candidate is PersistedClawPackageRef =>
        Boolean(candidate && (!query?.agentId || candidate.agentId === query.agentId)),
      ),
    readInstalls: async () => [
      { agentId: "worker", workspace },
      ...otherRefs.map((candidate) => ({ agentId: candidate.agentId, workspace })),
    ],
    replaceExpected: async (
      expected: PersistedClawPackageRef | undefined,
      replacement: PersistedClawPackageRef | undefined,
    ) => {
      expect(current).toEqual(expected);
      current = replacement;
    },
    packageDeps: {
      acquirePackageLease: vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() })),
    },
  };
  return {
    action,
    current: () => current,
    oldLock,
    oldOrigin,
    options,
    otherRefs,
    previous,
    root,
    skillDir,
    targetAddPlan,
    v1,
    v2,
    workspace,
  };
}

async function setupInstalledClaw() {
  const current = await setup();
  const env = { OPENCLAW_STATE_DIR: path.join(current.root, "state") };
  const initialPlan: ClawAddPlan = {
    ...current.targetAddPlan,
    claw: {
      ...current.targetAddPlan.claw,
      version: "1.0.0",
      integrity: current.v1.integrity,
    },
    actions: current.targetAddPlan.actions.map((action) => ({
      ...action,
      target: "clawhub:triage@1.0.0",
      details: {
        ...action.details,
        version: "1.0.0",
        integrity: current.v1.integrity,
      },
    })),
  };
  persistClawInstallRecord(initialPlan, { env });
  persistClawPackageRef(
    initialPlan,
    {
      kind: "skill",
      source: "clawhub",
      ref: "triage",
      version: "1.0.0",
      integrity: current.v1.integrity,
    },
    { env, nowMs: Date.now() + 1_000 },
  );
  const config = { agents: { entries: { worker: { workspace: current.workspace } } } };
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker" },
    workspace: { bootstrapFiles: {}, files: [] },
    packages: [{ kind: "skill", source: "clawhub", ref: "triage", version: "2.0.0" }],
    mcpServers: {},
    cronJobs: [],
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const packagePreflight = (pkg: (typeof parsed.manifest.packages)[number], workspace: string) =>
    preflightClawPackage(pkg, workspace);
  const updatePlan = await buildClawUpdatePlan({
    agentId: "worker",
    targetManifest: parsed.manifest,
    targetSource: current.targetAddPlan.claw,
    config,
    sourceMcpServers: {},
    stateOptions: { env },
    packagePreflight,
  });
  return { ...current, config, env, manifest: parsed.manifest, packagePreflight, updatePlan };
}

describe("owned ClawHub skill upgrade", () => {
  afterEach(() => {
    __setFsSafeTestHooksForTest(undefined);
    registry.detail.mockReset();
    registry.download.mockReset();
    registry.verify.mockReset();
    registry.telemetry.mockReset();
  });

  it("replaces exact v2 bytes and index, then restores v1 after downstream rollback", async () => {
    const current = await setup();
    const execution = await applyClawPackageUpdate(
      createClawUpdatePlanFixture([current.action]),
      current.targetAddPlan,
      current.options,
    );

    expect(current.current()).toMatchObject({ version: "2.0.0", integrity: current.v2.integrity });
    expect(await fs.readFile(path.join(current.skillDir, "SKILL.md"), "utf8")).toBe(
      current.v2.content,
    );
    expect((await readClawHubSkillsLockfile(current.workspace)).skills.triage).toMatchObject({
      version: "2.0.0",
      artifact: { integrity: current.v2.integrity },
    });
    expect(await readClawHubSkillOrigin(current.skillDir)).toMatchObject({
      installedVersion: "2.0.0",
      artifact: { integrity: current.v2.integrity },
    });

    await execution.rollback();
    expect(current.current()).toEqual(current.previous);
    expect(await fs.readFile(path.join(current.skillDir, "SKILL.md"), "utf8")).toBe(
      current.v1.content,
    );
    expect(await readClawHubSkillsLockfile(current.workspace)).toEqual(current.oldLock);
    expect(await readClawHubSkillOrigin(current.skillDir)).toEqual(current.oldOrigin);
  });

  it("marks a blocked deferred rollback partial without overwriting changed tracking", async () => {
    const current = await setup();
    const execution = await applyClawPackageUpdate(
      createClawUpdatePlanFixture([current.action]),
      current.targetAddPlan,
      current.options,
    );
    const lock = await readClawHubSkillsLockfile(current.workspace);
    lock.skills.triage!.version = "operator-version";
    await fs.writeFile(path.join(current.workspace, ".clawhub", "lock.json"), JSON.stringify(lock));

    await expect(execution.rollback()).rejects.toMatchObject({ partial: true });
    expect(current.current()).toMatchObject({ version: "2.0.0" });
    expect(await fs.readFile(path.join(current.skillDir, "SKILL.md"), "utf8")).toBe(
      current.v2.content,
    );
    expect((await readClawHubSkillsLockfile(current.workspace)).skills.triage?.version).toBe(
      "operator-version",
    );
  });

  it("keeps the upgraded skill and lockfile when the rollback lease closes during planning", async () => {
    const current = await setup();
    const readRefs = current.options.readRefs;
    let leaseCount = 0;
    let rollbackLeaseCurrent = true;
    current.options.packageDeps.acquirePackageLease = vi.fn(() => {
      const rollbackLease = ++leaseCount === 2;
      return {
        heartbeat: vi.fn(() => {
          if (rollbackLease && !rollbackLeaseCurrent) {
            throw new Error("rollback lease lost");
          }
        }),
        release: vi.fn(),
      };
    });
    current.options.readRefs = async (query) => {
      const refs = await readRefs(query);
      if (leaseCount === 2) {
        rollbackLeaseCurrent = false;
      }
      return refs;
    };
    const execution = await applyClawPackageUpdate(
      createClawUpdatePlanFixture([current.action]),
      current.targetAddPlan,
      current.options,
    );
    const upgradedLock = await readClawHubSkillsLockfile(current.workspace);

    await expect(execution.rollback()).rejects.toMatchObject({ partial: true });
    expect(leaseCount).toBe(2);
    expect(current.current()).toMatchObject({ version: "2.0.0" });
    expect(await fs.readFile(path.join(current.skillDir, "SKILL.md"), "utf8")).toBe(
      current.v2.content,
    );
    expect(await readClawHubSkillsLockfile(current.workspace)).toEqual(upgradedLock);
  });

  it("does not touch bytes or ownership when the old tracked tree drifted", async () => {
    const current = await setup();
    await fs.writeFile(path.join(current.skillDir, "SKILL.md"), "operator edits\n");

    await expect(
      applyClawPackageUpdate(
        createClawUpdatePlanFixture([current.action]),
        current.targetAddPlan,
        current.options,
      ),
    ).rejects.toMatchObject({ partial: false });

    expect(current.current()).toEqual(current.previous);
    expect(await fs.readFile(path.join(current.skillDir, "SKILL.md"), "utf8")).toBe(
      "operator edits\n",
    );
    expect(await readClawHubSkillsLockfile(current.workspace)).toEqual(current.oldLock);
    expect(registry.download).toHaveBeenCalledTimes(1);
  });

  it.each(["complete", "failed"] as const)(
    "does not replace a skill with another Claw's %s ref in the same workspace",
    async (status) => {
      const current = await setup();
      current.otherRefs.push({
        ...current.previous,
        agentId: "other",
        ref: "@owner/triage",
        status,
      });

      await expect(
        applyClawPackageUpdate(
          createClawUpdatePlanFixture([current.action]),
          current.targetAddPlan,
          current.options,
        ),
      ).rejects.toMatchObject({ partial: false });

      expect(current.current()).toEqual(current.previous);
      expect(await fs.readFile(path.join(current.skillDir, "SKILL.md"), "utf8")).toBe(
        current.v1.content,
      );
      expect(await readClawHubSkillsLockfile(current.workspace)).toEqual(current.oldLock);
      expect(registry.download).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses an intact v1 skill whose tracked artifact differs from the Claw ref", async () => {
    const current = await setup();
    current.previous.integrity = `sha256:${"c".repeat(64)}`;
    current.action.currentDigest = digestClawPackageRef(current.previous);

    await expect(
      applyClawPackageUpdate(
        createClawUpdatePlanFixture([current.action]),
        current.targetAddPlan,
        current.options,
      ),
    ).rejects.toMatchObject({
      partial: false,
      message: expect.stringContaining("recorded artifact"),
    });

    expect(current.current()).toEqual(current.previous);
    expect(await fs.readFile(path.join(current.skillDir, "SKILL.md"), "utf8")).toBe(
      current.v1.content,
    );
    expect(await readClawHubSkillsLockfile(current.workspace)).toEqual(current.oldLock);
    expect(registry.download).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed v2 archive before replacing v1", async () => {
    const current = await setup();
    current.targetAddPlan.actions[0]!.details!.integrity = `sha256:${"c".repeat(64)}`;

    await expect(
      applyClawPackageUpdate(
        createClawUpdatePlanFixture([current.action]),
        current.targetAddPlan,
        current.options,
      ),
    ).rejects.toMatchObject({ partial: false });

    expect(current.current()).toEqual(current.previous);
    expect(await fs.readFile(path.join(current.skillDir, "SKILL.md"), "utf8")).toBe(
      current.v1.content,
    );
    expect(await readClawHubSkillsLockfile(current.workspace)).toEqual(current.oldLock);
    expect(registry.download).toHaveBeenCalledTimes(2);
  });

  it("reports a partial update if deferred directory recovery cannot restore v1", async () => {
    const current = await setup();
    const realRename = fs.rename.bind(fs);
    let intervened = false;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      await realRename(...args);
      if (
        !intervened &&
        path.basename(String(args[0])).startsWith(".fs-safe-move-") &&
        path.basename(path.dirname(String(args[1]))) === ".openclaw-install-backups"
      ) {
        intervened = true;
        await fs.mkdir(current.skillDir, { recursive: true });
        await fs.writeFile(path.join(current.skillDir, "successor.txt"), "operator replacement");
      }
    });
    try {
      await expect(
        applyClawPackageUpdate(
          createClawUpdatePlanFixture([current.action]),
          current.targetAddPlan,
          current.options,
        ),
      ).rejects.toMatchObject({ partial: true });
    } finally {
      rename.mockRestore();
    }

    expect(intervened).toBe(true);
    expect(current.current()).toMatchObject({ status: "failed", version: "2.0.0" });
    await expect(fs.readFile(path.join(current.skillDir, "successor.txt"), "utf8")).resolves.toBe(
      "operator replacement",
    );
  });

  it("restores v1 if tracking fails after the v2 directory was published", async () => {
    const current = await setup();
    const planned = await planClawHubSkillUninstall({
      workspaceDir: current.workspace,
      slug: "triage",
      expectedVersion: "1.0.0",
    });
    if (!planned.ok) {
      throw new Error(planned.error);
    }
    let sawV2 = false;
    const result = await installSkillFromClawHub({
      workspaceDir: current.workspace,
      slug: "triage",
      version: "2.0.0",
      expectedIntegrity: current.v2.integrity,
      force: true,
      clawManaged: true,
      deferCommit: true,
      expectedClawHubState: planned.plan,
      assertOwned: () => undefined,
      beforePersistentApply: () => {
        try {
          if (
            fsSync.readFileSync(path.join(current.skillDir, "SKILL.md"), "utf8") ===
            current.v2.content
          ) {
            sawV2 = true;
            throw new Error("tracking write denied");
          }
        } catch (error) {
          if (sawV2) {
            throw error;
          }
        }
      },
    });

    expect(sawV2).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("tracking write denied"),
    });
    expect(await fs.readFile(path.join(current.skillDir, "SKILL.md"), "utf8")).toBe(
      current.v1.content,
    );
    expect(await readClawHubSkillsLockfile(current.workspace)).toEqual(current.oldLock);
    expect(await readClawHubSkillOrigin(current.skillDir)).toEqual(current.oldOrigin);
  });

  it("does not rewrite the lockfile after rollback loses its owner", async () => {
    const current = await setup();
    const planned = await planClawHubSkillUninstall({
      workspaceDir: current.workspace,
      slug: "triage",
      expectedVersion: "1.0.0",
    });
    if (!planned.ok) {
      throw new Error(planned.error);
    }
    const upgraded = await installSkillFromClawHub({
      workspaceDir: current.workspace,
      slug: "triage",
      version: "2.0.0",
      expectedIntegrity: current.v2.integrity,
      force: true,
      clawManaged: true,
      deferCommit: true,
      expectedClawHubState: planned.plan,
      assertOwned: () => undefined,
    });
    if (!upgraded.ok || !upgraded.transaction) {
      throw new Error("expected deferred skill upgrade");
    }
    const upgradedLock = await readClawHubSkillsLockfile(current.workspace);
    const lost = new Error("rollback lease lost before lockfile restore");
    let rollbackLeaseCurrent = true;
    let sawRestoredDir = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation(operation, target) {
        if (
          operation === "remove" &&
          path.basename(target).startsWith(".openclaw-install-rollback-")
        ) {
          sawRestoredDir =
            fsSync.readFileSync(path.join(current.skillDir, "SKILL.md"), "utf8") ===
            current.v1.content;
          rollbackLeaseCurrent = false;
        }
      },
    });
    const assertCurrent = () => {
      if (!rollbackLeaseCurrent) {
        throw lost;
      }
    };

    await expect(upgraded.transaction.rollback(assertCurrent)).rejects.toBe(lost);
    expect(sawRestoredDir).toBe(true);
    expect(await fs.readFile(path.join(current.skillDir, "SKILL.md"), "utf8")).toBe(
      current.v1.content,
    );
    expect(await readClawHubSkillsLockfile(current.workspace)).toEqual(upgradedLock);
  });

  it("rolls back a fully planned skill upgrade when a later Claw stage fails", async () => {
    const current = await setupInstalledClaw();
    expect(current.updatePlan.blockers).toEqual([]);
    expect(current.updatePlan.actions).toContainEqual(
      expect.objectContaining({ kind: "package", id: "skill:triage", action: "change" }),
    );

    await expect(
      applyClawUpdatePlan(
        current.updatePlan,
        { targetManifest: current.manifest, targetSource: current.targetAddPlan.claw },
        {
          env: current.env,
          config: current.config,
          sourceMcpServers: {},
          consentPlanIntegrity: current.updatePlan.planIntegrity,
          packagePreflight: current.packagePreflight,
          applyCron: async () => {
            throw new Error("downstream cron failure");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "cron_update_failed" });

    expect(await fs.readFile(path.join(current.skillDir, "SKILL.md"), "utf8")).toBe(
      current.v1.content,
    );
    expect(await readClawHubSkillsLockfile(current.workspace)).toEqual(current.oldLock);
    expect(await readClawHubSkillOrigin(current.skillDir)).toEqual(current.oldOrigin);
    expect(readClawPackageRefs({ env: current.env, agentId: "worker" })).toMatchObject([
      { version: "1.0.0", integrity: current.v1.integrity },
    ]);
    expect(readClawInstallRecord("worker", { env: current.env })?.claw.version).toBe("1.0.0");
  });

  it("commits a fully planned skill upgrade and keeps Gateway planning usable", async () => {
    const current = await setupInstalledClaw();
    const result = await applyClawUpdatePlan(
      current.updatePlan,
      { targetManifest: current.manifest, targetSource: current.targetAddPlan.claw },
      {
        env: current.env,
        config: current.config,
        sourceMcpServers: {},
        consentPlanIntegrity: current.updatePlan.planIntegrity,
        packagePreflight: current.packagePreflight,
      },
    );

    expect(result.status).toBe("complete");
    expect(readClawPackageRefs({ env: current.env, agentId: "worker" })).toMatchObject([
      { version: "2.0.0", integrity: current.v2.integrity },
    ]);
    expect(await fs.readFile(path.join(current.skillDir, "SKILL.md"), "utf8")).toBe(
      current.v2.content,
    );
    expect((await readClawHubSkillsLockfile(current.workspace)).skills.triage).toMatchObject({
      version: "2.0.0",
      artifact: { integrity: current.v2.integrity },
    });
    expect(readClawInstallRecord("worker", { env: current.env })?.claw.version).toBe("2.0.0");
    const backupDir = path.join(current.workspace, "skills", ".openclaw-install-backups");
    expect(await fs.readdir(backupDir)).toEqual([]);

    const nextPlan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: current.targetAddPlan.claw,
      config: current.config,
      sourceMcpServers: {},
      stateOptions: { env: current.env },
      packagePreflight: current.packagePreflight,
    });
    expect(nextPlan.actions).toContainEqual(
      expect.objectContaining({ kind: "package", id: "skill:triage", action: "unchanged" }),
    );
  });

  it("commits a skill upgrade after the reviewed agent access changes", async () => {
    const current = await setupInstalledClaw();
    const targetOpenClawProfile: ClawOpenClawProfile = {
      schemaVersion: 1,
      agent: { tools: { deny: ["web_fetch"] } },
    };
    const updatePlan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetOpenClawProfile,
      targetSource: current.targetAddPlan.claw,
      config: current.config,
      sourceMcpServers: {},
      stateOptions: { env: current.env },
      packagePreflight: current.packagePreflight,
    });
    expect(updatePlan.blockers).toEqual([]);
    expect(updatePlan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", action: "change" }),
        expect.objectContaining({ kind: "package", id: "skill:triage", action: "change" }),
      ]),
    );
    let config: OpenClawConfig = current.config;
    let reviewedAccess: ReturnType<typeof projectClawConfiguredAccess> | undefined;
    const assertReviewedConfig = vi.fn(
      (runtime: OpenClawConfig, desiredAgent: AgentConfig, phase?: "after-agent-commit") => {
        const actual = projectClawConfiguredAccess({
          config: runtime,
          agentId: "worker",
          desiredAgent,
          operation: "update",
        });
        reviewedAccess ??= actual;
        const matches =
          phase === "after-agent-commit"
            ? digestClawValue(actual.current) === digestClawValue(reviewedAccess.desired) &&
              digestClawValue(actual.desired) === digestClawValue(reviewedAccess.desired)
            : digestClawValue(actual) === digestClawValue(reviewedAccess);
        if (!matches) {
          throw new ClawUpdateMutationError(
            "reviewed_access_changed",
            "The effective Claw access changed since review. Preview it again.",
          );
        }
      },
    );

    const result = await applyClawUpdatePlan(
      updatePlan,
      {
        targetManifest: current.manifest,
        targetOpenClawProfile,
        targetSource: current.targetAddPlan.claw,
      },
      {
        env: current.env,
        config: current.config,
        getCurrentConfig: () => config,
        assertReviewedConfig,
        sourceMcpServers: {},
        consentPlanIntegrity: updatePlan.planIntegrity,
        packagePreflight: current.packagePreflight,
        commitConfig: async (transform, beforeCommit) => {
          const next = transform(config, config);
          beforeCommit?.();
          config = next;
        },
      },
    );

    expect(result.status).toBe("complete");
    expect(config.agents?.entries?.worker?.tools?.deny).toEqual(["web_fetch"]);
    expect(assertReviewedConfig).toHaveBeenCalledWith(
      config,
      expect.anything(),
      "after-agent-commit",
    );
    expect(
      await fs.readdir(path.join(current.workspace, "skills", ".openclaw-install-backups")),
    ).toEqual([]);
  });

  it("retains the previous skill backup when the commit lease is lost", async () => {
    const current = await setup();
    let leaseCount = 0;
    current.options.packageDeps.acquirePackageLease = vi.fn(() => {
      const commitLease = ++leaseCount === 2;
      return {
        heartbeat: vi.fn(() => {
          if (commitLease) {
            throw new Error("commit lease lost");
          }
        }),
        release: vi.fn(),
      };
    });
    const execution = await applyClawPackageUpdate(
      createClawUpdatePlanFixture([current.action]),
      current.targetAddPlan,
      current.options,
    );
    const backupRoot = path.join(current.workspace, "skills", ".openclaw-install-backups");
    const backups = await fs.readdir(backupRoot);
    expect(backups).toHaveLength(1);

    await expect(execution.commit?.()).rejects.toThrow("commit lease lost");
    expect(leaseCount).toBe(2);
    expect(await fs.readdir(backupRoot)).toEqual(backups);
    expect(await fs.readFile(path.join(current.skillDir, "SKILL.md"), "utf8")).toBe(
      current.v2.content,
    );
  });

  it("permits a second exact upgrade after the first skill install completes", async () => {
    const current = await setupInstalledClaw();
    const v3 = await makeArchive(current.root, "3.0.0");
    registry.download.mockImplementation(async (params: { version: string }) => {
      if (params.version === "2.0.0") {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
        return current.v2;
      }
      return params.version === "3.0.0" ? v3 : current.v1;
    });
    await applyClawUpdatePlan(
      current.updatePlan,
      { targetManifest: current.manifest, targetSource: current.targetAddPlan.claw },
      {
        env: current.env,
        config: current.config,
        sourceMcpServers: {},
        consentPlanIntegrity: current.updatePlan.planIntegrity,
        packagePreflight: current.packagePreflight,
      },
    );
    const secondManifest = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker" },
      workspace: { bootstrapFiles: {}, files: [] },
      packages: [{ kind: "skill", source: "clawhub", ref: "triage", version: "3.0.0" }],
      mcpServers: {},
      cronJobs: [],
    });
    if (!secondManifest.ok) {
      throw new Error(JSON.stringify(secondManifest.diagnostics));
    }
    const secondSource = {
      ...current.targetAddPlan.claw,
      version: "3.0.0",
      integrity: v3.integrity,
    };
    const secondPlan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: secondManifest.manifest,
      targetSource: secondSource,
      config: current.config,
      sourceMcpServers: {},
      stateOptions: { env: current.env },
      packagePreflight: current.packagePreflight,
    });
    expect(secondPlan.blockers).toEqual([]);
    expect(secondPlan.actions).toContainEqual(
      expect.objectContaining({ kind: "package", id: "skill:triage", action: "change" }),
    );

    await applyClawUpdatePlan(
      secondPlan,
      { targetManifest: secondManifest.manifest, targetSource: secondSource },
      {
        env: current.env,
        config: current.config,
        sourceMcpServers: {},
        consentPlanIntegrity: secondPlan.planIntegrity,
        packagePreflight: current.packagePreflight,
      },
    );
    expect(await fs.readFile(path.join(current.skillDir, "SKILL.md"), "utf8")).toBe(v3.content);
    expect(readClawPackageRefs({ env: current.env, agentId: "worker" })).toMatchObject([
      { version: "3.0.0", integrity: v3.integrity },
    ]);
  });
});
