import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensureInstallTargetAvailable } from "../infra/install-target.js";
import { commitPluginInstallRecordsWithConfig } from "../plugins/install-record-commit.js";
import type { installManagedPlugin } from "../plugins/management-mutations.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { hasPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { digestClawHubSkillTree } from "../skills/lifecycle/skill-tree-digest.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { digestClawPackageRef } from "./package-update-provenance.js";
import { applyClawPackageUpdate } from "./package-update.js";
import { installClawPackages } from "./packages.js";
import { emptyPluginCapabilityEvidence } from "./packages.test-support.js";
import { CLAW_PACKAGE_REF_SCHEMA_VERSION, type PersistedClawPackageRef } from "./provenance.js";
import { createClawUpdatePlanFixture as plan } from "./resource-update.test-helpers.js";
import {
  CLAW_OUTPUT_STABILITY,
  type ClawAddPlan,
  type ClawManifest,
  type ResolvedClawPackage,
} from "./types.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);

function ref(kind: "skill" | "plugin", name: string, version: string): PersistedClawPackageRef {
  return {
    schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
    agentId: "worker",
    clawName: "@acme/worker",
    kind,
    source: "clawhub",
    ref: name,
    version,
    integrity: `sha256:${name}-${version}`,
    status: "complete",
    relationship: kind === "skill" ? "managed" : "referenced",
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: 10,
    updatedAtMs: 10,
  };
}

async function trackSkill(workspace: string, integrity: string) {
  const skillDir = path.join(workspace, "skills", "triage");
  const content = "previous skill bytes";
  await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
  await fs.mkdir(path.join(workspace, ".clawhub"), { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content);
  const metadata = {
    registry: "https://clawhub.ai",
    installedAt: 1,
    artifact: { kind: "archive", integrity, sha256: "a".repeat(64) },
    skillFile: { path: "SKILL.md", sha256: createHash("sha256").update(content).digest("hex") },
    fileTreeSha256: await digestClawHubSkillTree(skillDir),
  };
  await fs.writeFile(
    path.join(skillDir, ".clawhub", "origin.json"),
    JSON.stringify({ version: 1, slug: "triage", installedVersion: "1.0.0", ...metadata }),
  );
  const lock = JSON.stringify({
    version: 1,
    skills: { triage: { version: "1.0.0", ...metadata } },
  });
  await fs.writeFile(path.join(workspace, ".clawhub", "lock.json"), lock);
  return { skillDir, lock };
}

const manifest: ClawManifest = {
  schemaVersion: 1,
  agent: { id: "worker" },
  workspace: { bootstrapFiles: {}, files: [] },
  packages: [
    {
      kind: "skill",
      source: "clawhub",
      ref: "triage",
      version: "2.0.0",
    },
    {
      kind: "plugin",
      source: "clawhub",
      ref: "audit",
      version: "1.0.0",
    },
  ],
  mcpServers: {},
  cronJobs: [],
};

const addPlan: ClawAddPlan = {
  schemaVersion: "openclaw.clawAddPlan.v1",
  stability: CLAW_OUTPUT_STABILITY,
  dryRun: true,
  mutationAllowed: false,
  manifestSchemaVersion: 1,
  planIntegrity: "sha256:add-plan",
  claw: {
    kind: "package",
    name: "@acme/worker",
    version: "2.0.0",
    packageRoot: "/tmp/claw",
    manifestPath: "/tmp/claw/openclaw.claw.json",
    integrityKind: "artifact",
    integrity: "sha256:new",
    byteLength: 1,
  },
  agent: {
    requestedId: "worker",
    finalId: "worker",
    workspace: "/tmp/worker",
    config: { id: "worker", workspace: "/tmp/worker" },
  },
  summary: {
    totalActions: 2,
    agentActions: 0,
    workspaceActions: 0,
    packageActions: 2,
    mcpServerActions: 0,
    cronJobActions: 0,
    blockedActions: 0,
    capabilityEscalations: 0,
  },
  actions: manifest.packages.map((pkg) => ({
    kind: "package",
    id: `${pkg.kind}:${pkg.ref}`,
    action: "install",
    target: `clawhub:${pkg.ref}@${pkg.version}`,
    details: {
      ...pkg,
      integrity: `sha256:${pkg.ref}-${pkg.version}`,
      ownerAction: "install",
      ...(pkg.kind === "plugin"
        ? {
            installId: pkg.ref,
            declaredCapabilities: emptyPluginCapabilityEvidence.declared,
            capabilityGrants: emptyPluginCapabilityEvidence.grants,
          }
        : {}),
    },
    blocked: false,
  })),
  capabilityChanges: [],
  blockers: [],
  diagnostics: [],
  readiness: { ready: true, requirements: [] },
};

describe("applyClawPackageUpdate", () => {
  it("hashes only persisted package provenance from enriched status records", () => {
    const persisted = ref("plugin", "audit", "1.0.0");
    expect(
      digestClawPackageRef({
        ...persisted,
        state: "present",
        extensionCompatibility: { state: "compatible" },
      } as typeof persisted),
    ).toBe(digestClawPackageRef(persisted));
  });

  it("keeps existing skill bytes and index untouched when update warning consent is missing", async () => {
    const root = dirs.make("claw-skill-warning-");
    const skillFile = path.join(root, "skills", "triage", "SKILL.md");
    const indexFile = path.join(root, "skills", ".clawhub", "lock.json");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.mkdir(path.dirname(indexFile), { recursive: true });
    await fs.writeFile(skillFile, "previous skill bytes");
    await fs.writeFile(indexFile, '{"version":"1.0.0"}');
    const previous = ref("skill", "triage", "1.0.0");
    const targetAction = addPlan.actions.find((action) => action.id === "skill:triage")!;
    const targetPlan: ClawAddPlan = {
      ...addPlan,
      actions: [
        {
          ...targetAction,
          details: { ...targetAction.details, riskWarning: "Review this skill update." },
        },
      ],
    };
    const replaceExpected = vi.fn();
    const installPackages = vi.fn(async () => {
      await fs.writeFile(skillFile, "new skill bytes");
      await fs.writeFile(indexFile, '{"version":"2.0.0"}');
      return [];
    });

    await expect(
      applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "skill:triage",
            action: "change",
            target: "clawhub:triage@2.0.0",
            blocked: false,
            reason: "Upgrade managed skill",
            currentDigest: digestClawPackageRef(previous),
          },
        ]),
        targetPlan,
        { readRefs: () => [previous], replaceExpected, installPackages },
      ),
    ).rejects.toThrow(/trust warning acknowledgement/i);
    expect(replaceExpected).not.toHaveBeenCalled();
    expect(installPackages).not.toHaveBeenCalled();
    expect(await fs.readFile(skillFile, "utf8")).toBe("previous skill bytes");
    expect(await fs.readFile(indexFile, "utf8")).toBe('{"version":"1.0.0"}');
  });

  it("rolls back a skill update when the live installer warning differs from the reviewed warning", async () => {
    const root = dirs.make("claw-skill-warning-change-");
    const skillFile = path.join(root, "skills", "triage", "SKILL.md");
    const indexFile = path.join(root, ".clawhub", "lock.json");
    const previousIntegrity = `sha256:${"a".repeat(64)}`;
    const tracked = await trackSkill(root, previousIntegrity);
    const previous = {
      ...ref("skill", "triage", "1.0.0"),
      integrity: previousIntegrity,
      updatedAtMs: Date.now() + 1_000,
    };
    let current: PersistedClawPackageRef | undefined = previous;
    const integrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const targetAction = addPlan.actions.find((action) => action.id === "skill:triage")!;
    const targetPlan: ClawAddPlan = {
      ...addPlan,
      agent: { ...addPlan.agent, workspace: root },
      actions: [
        {
          ...targetAction,
          details: {
            ...targetAction.details,
            integrity,
            riskWarning: "Reviewed skill warning.",
          },
        },
      ],
    };
    const replaceExpected = vi.fn(
      async (
        expected: PersistedClawPackageRef | undefined,
        replacement: PersistedClawPackageRef | undefined,
      ) => {
        expect(current).toEqual(expected);
        current = replacement;
      },
    );
    const installSkill = vi.fn(
      async (params: {
        confirmInstall?: (warning?: string) => boolean | Promise<boolean>;
        beforePersistentApply?: () => void;
      }) => {
        expect(await params.confirmInstall?.("Changed skill warning.")).toBe(false);
        return { ok: false as const, error: "Install cancelled." };
      },
    );

    await expect(
      applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "skill:triage",
            action: "change",
            target: "clawhub:triage@2.0.0",
            blocked: false,
            reason: "Upgrade managed skill",
            currentDigest: digestClawPackageRef(previous),
          },
        ]),
        targetPlan,
        {
          readRefs: () => (current ? [current] : []),
          readInstalls: () => [{ agentId: "worker", workspace: root }],
          replaceExpected,
          skillConsent: { assertApproved: vi.fn() },
          packageDeps: {
            preflightSkill: vi.fn().mockResolvedValue({
              ok: false,
              code: "skill_version_conflict",
              error: "v1 occupies triage",
              integrity,
              warning: "Reviewed skill warning.",
            }),
            installSkill,
            acquirePackageLease: vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() })),
          },
        },
      ),
    ).rejects.toMatchObject({ partial: false });
    expect(installSkill).toHaveBeenCalledOnce();
    expect(current).toEqual(previous);
    expect(await fs.readFile(skillFile, "utf8")).toBe("previous skill bytes");
    expect(await fs.readFile(indexFile, "utf8")).toBe(tracked.lock);
  });

  it("rechecks reviewed access after package reads before changing an owned reference", async () => {
    const previous = ref("skill", "triage", "1.0.0");
    const replaceExpected = vi.fn();
    let accessCurrent = true;

    await expect(
      applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "skill:triage",
            action: "release",
            target: "clawhub:triage@1.0.0",
            blocked: false,
            reason: "release ownership",
            currentDigest: digestClawPackageRef(previous),
          },
        ]),
        addPlan,
        {
          readRefs: async () => {
            accessCurrent = false;
            return [previous];
          },
          replaceExpected,
          assertForwardCurrent: () => {
            if (!accessCurrent) {
              throw new Error("reviewed access changed");
            }
          },
        },
      ),
    ).rejects.toThrow("reviewed access changed");

    expect(replaceExpected).not.toHaveBeenCalled();
  });

  it("adds extension metadata to a reused v1 plugin edge without changing ownership", async () => {
    const previous = ref("plugin", "audit", "1.0.0");
    const extension = {
      id: "audit-tools",
      format: "claude" as const,
      detectedFormat: "claude" as const,
      mapped: ["skills"],
      unavailable: ["agents"],
      adapterIdentity: "openclaw/test",
    };
    const targetPlan: ClawAddPlan = {
      ...addPlan,
      actions: [
        {
          kind: "package",
          id: "plugin:audit",
          action: "install",
          target: "clawhub:audit@1.0.0",
          blocked: false,
          details: {
            kind: "plugin",
            source: "clawhub",
            ref: "audit",
            version: "1.0.0",
            integrity: previous.integrity,
            ownerAction: "reuse",
            installId: "audit",
            extension,
          },
        },
      ],
    };
    const replaceExpected = vi.fn();
    const installPackages = vi.fn(
      async (current: ClawAddPlan, options: Parameters<typeof installClawPackages>[1]) => {
        const persisted = options?.deps?.persistPackageRef;
        if (!persisted) {
          throw new Error("expected package provenance adapter");
        }
        return [
          await persisted(current, current.actions[0]!.details as ResolvedClawPackage, {
            status: "complete",
            relationship: "referenced",
            origin: "pre-existing",
            independentOwner: true,
          }),
        ];
      },
    );

    await applyClawPackageUpdate(
      plan([
        {
          kind: "package",
          id: "plugin:audit",
          action: "change",
          target: "clawhub:audit@1.0.0",
          blocked: false,
          reason: "relocated",
          currentDigest: digestClawPackageRef(previous),
        },
      ]),
      targetPlan,
      {
        installPackages,
        readRefs: () => [previous],
        replaceExpected,
        nowMs: 20,
      },
    );

    expect(replaceExpected).toHaveBeenCalledWith(
      previous,
      expect.objectContaining({
        extension,
        origin: "claw-introduced",
        independentOwner: false,
        installedAtMs: 10,
      }),
      expect.any(Object),
    );
  });

  it.each([false, true])(
    "updates exact references but reports retained artifacts on rollback (undo errors: %s)",
    async (rollbackErrors) => {
      const oldSkill = ref("plugin", "triage", "1.0.0");
      const legacy = ref("plugin", "legacy", "1.0.0");
      const installPackages = vi.fn(
        async (current: ClawAddPlan, options: Parameters<typeof installClawPackages>[1]) => {
          const details = current.actions[0]?.details as {
            kind: "skill" | "plugin";
            ref: string;
            version: string;
            integrity: string;
          };
          options?.onExternalMutation?.({ ...details, source: "clawhub" });
          return [ref(details.kind, details.ref, details.version)];
        },
      );
      let rollingBack = false;
      const replaceExpected = vi.fn(
        (expected?: PersistedClawPackageRef, next?: PersistedClawPackageRef) => {
          if (rollingBack && rollbackErrors) {
            throw new Error((next ?? expected)?.ref);
          }
        },
      );
      const execution = await applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "plugin:triage",
            action: "change",
            target: "clawhub:triage@2.0.0",
            blocked: false,
            reason: "changed",
            currentDigest: digestClawPackageRef(oldSkill),
          },
          {
            kind: "package",
            id: "plugin:audit",
            action: "add",
            target: "clawhub:audit@1.0.0",
            blocked: false,
            reason: "added",
          },
          {
            kind: "package",
            id: "plugin:legacy",
            action: "release",
            target: "clawhub:legacy@1.0.0",
            blocked: false,
            reason: "removed",
            currentDigest: digestClawPackageRef(legacy),
          },
        ]),
        {
          ...addPlan,
          actions: addPlan.actions.map((action) =>
            action.id === "skill:triage"
              ? {
                  ...action,
                  id: "plugin:triage",
                  details: { ...action.details, kind: "plugin", installId: "triage" },
                }
              : action,
          ),
        },
        {
          installPackages,
          readRefs: () => [oldSkill, legacy],
          replaceExpected,
        },
      );

      expect(execution.appliedIds).toEqual(["plugin:triage", "plugin:audit", "plugin:legacy"]);
      expect(installPackages).toHaveBeenCalledTimes(2);
      expect(replaceExpected).toHaveBeenCalledWith(
        oldSkill,
        expect.objectContaining({ version: "2.0.0", status: "pending" }),
        expect.any(Object),
      );
      expect(replaceExpected).toHaveBeenCalledWith(legacy, undefined, expect.any(Object));

      rollingBack = true;
      await expect(execution.rollback()).rejects.toMatchObject({
        partial: true,
        message:
          (rollbackErrors ? "legacy; audit; triage; " : "") +
          "package artifacts may have been retained: plugin:triage@2.0.0, plugin:audit@1.0.0",
      });
      expect(replaceExpected).toHaveBeenCalledWith(undefined, legacy, expect.any(Object));
      expect(replaceExpected).toHaveBeenCalledWith(
        expect.objectContaining({ version: "2.0.0", status: "complete" }),
        oldSkill,
        expect.any(Object),
      );
    },
  );

  it("reverses reference-only removal without uninstalling or reporting partial state", async () => {
    const legacy = ref("plugin", "legacy", "1.0.0");
    const replaceExpected = vi.fn();
    const execution = await applyClawPackageUpdate(
      plan([
        {
          kind: "package",
          id: "plugin:legacy",
          action: "release",
          target: "clawhub:legacy@1.0.0",
          blocked: false,
          reason: "removed",
          currentDigest: digestClawPackageRef(legacy),
        },
      ]),
      { ...addPlan, actions: [] },
      { readRefs: () => [legacy], replaceExpected },
    );

    await expect(execution.rollback()).resolves.toBeUndefined();
    expect(replaceExpected).toHaveBeenNthCalledWith(1, legacy, undefined, expect.any(Object));
    expect(replaceExpected).toHaveBeenNthCalledWith(2, undefined, legacy, expect.any(Object));
  });

  it("releases managed package provenance without uninstalling the artifact", async () => {
    const oldSkill = ref("skill", "triage", "1.0.0");
    const replaceExpected = vi.fn();
    const execution = await applyClawPackageUpdate(
      plan([
        {
          kind: "package",
          id: "skill:triage",
          action: "remove",
          target: "clawhub:triage@1.0.0",
          blocked: false,
          reason: "removed",
          currentDigest: digestClawPackageRef(oldSkill),
        },
      ]),
      { ...addPlan, actions: [] },
      {
        readRefs: () => [oldSkill],
        replaceExpected,
      },
    );

    expect(replaceExpected).toHaveBeenCalledWith(oldSkill, undefined, expect.any(Object));
    await expect(execution.rollback()).resolves.toBeUndefined();
    expect(replaceExpected).toHaveBeenCalledWith(undefined, oldSkill, expect.any(Object));
  });

  it("does not replace a shared plugin pinned by another Claw", async () => {
    const installPackages = vi.fn();
    const otherOwner = { ...ref("plugin", "audit", "0.9.0"), agentId: "other" };
    await expect(
      applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "plugin:audit",
            action: "add",
            target: "clawhub:audit@1.0.0",
            blocked: false,
            reason: "added",
          },
        ]),
        addPlan,
        {
          installPackages,
          readRefs: (options) => (options?.agentId ? [] : [otherOwner]),
        },
      ),
    ).rejects.toMatchObject({ partial: false });
    expect(installPackages).not.toHaveBeenCalled();
  });

  it("rejects release when package provenance changed after planning", async () => {
    const planned = ref("plugin", "legacy", "1.0.0");
    const observed = { ...planned, independentOwner: true };
    const replaceExpected = vi.fn();

    await expect(
      applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "plugin:legacy",
            action: "release",
            target: "clawhub:legacy@1.0.0",
            blocked: false,
            reason: "released",
            currentDigest: digestClawPackageRef(planned),
          },
        ]),
        { ...addPlan, actions: [] },
        { readRefs: () => [observed], replaceExpected },
      ),
    ).rejects.toMatchObject({ partial: false });
    expect(replaceExpected).not.toHaveBeenCalled();
  });

  it.each([
    { lateFailure: false, directReinstall: false },
    { lateFailure: true, directReinstall: false },
    { lateFailure: false, directReinstall: true },
  ])(
    "owned upgrade with late provenance failure=$lateFailure direct reinstall=$directReinstall",
    async ({ lateFailure, directReinstall }) => {
      const root = dirs.make("claw-owned-upgrade-");
      const targetDir = path.join(root, "plugins", "audit");
      await fs.mkdir(targetDir, { recursive: true });
      const env = {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      };
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
      const integrity = `sha256:${"a".repeat(64)}`;
      const previous = { ...ref("plugin", "audit", "0.9.0"), integrity };
      const targetPlan = {
        ...addPlan,
        actions: addPlan.actions
          .filter((action) => action.id === "plugin:audit")
          .map((action) =>
            Object.assign({}, action, {
              details: Object.assign({}, action.details, { integrity }),
            }),
          ),
      };
      const failure = new Error("late provenance failure");
      let committed = false;
      const priorRecords = {
        audit: {
          source: "clawhub" as const,
          clawhubPackage: "audit",
          installPath: targetDir,
          version: "0.9.0",
          integrity,
          installedAt: new Date(1).toISOString(),
        },
      };
      const currentRecords = { audit: { ...priorRecords.audit, version: "1.0.0" } };
      const uninstallPlugin = vi.fn(async () => {});
      const reloadPlugins = vi.fn(async () => {
        expect(hasPluginLifecycleLease()).toBe(false);
        return { operationId: "upgrade", generation: 4, pluginIds: ["audit"] };
      });
      const installPlugin = vi.fn(async (params: Parameters<typeof installManagedPlugin>[0]) => {
        if (params.request.source !== "clawhub") {
          throw new Error("expected ClawHub request");
        }
        const result = await ensureInstallTargetAvailable({
          targetDir,
          mode: params.request.mode ?? "install",
          alreadyExistsError: "plugin already exists",
        });
        if (!result.ok) {
          throw new Error(result.error);
        }
        if (directReinstall) {
          priorRecords.audit.installedAt = new Date(20).toISOString();
        }
        await params.beforePersistentEffect?.();
        const write = await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: priorRecords,
          nextInstallRecords: currentRecords,
          nextConfig: {},
          writeOptions: { afterWrite: { mode: "none", reason: "owned upgrade fixture" } },
        });
        params.deferRuntime?.record({
          operation: "install",
          pluginId: "audit",
          sourceDigests: {},
          write,
        });
        committed = true;
      });
      await withEnvAsync(env, async () => {
        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: {},
          nextInstallRecords: priorRecords,
          nextConfig: {},
          writeOptions: { afterWrite: { mode: "none", reason: "prior owner fixture" } },
        });
        const pending = applyClawPackageUpdate(
          plan([
            {
              kind: "package",
              id: "plugin:audit",
              action: "change",
              target: "clawhub:audit@1.0.0",
              blocked: false,
              reason: "owned upgrade",
            },
          ]),
          targetPlan,
          {
            env,
            pluginConsent: {
              onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
            },
            reloadPlugins,
            readRefs: () => [previous],
            replaceExpected: () => {
              if (lateFailure && committed) {
                throw failure;
              }
            },
            runtime: {
              log: () => {},
              error: () => {},
              exit: () => {
                throw new Error("unexpected exit");
              },
            },
            packageDeps: {
              installPlugin,
              uninstallPlugin,
              readPackageRefs: () => [{ ...previous, version: "1.0.0" }],
              resolvePlugin: async () => ({
                status: "found",
                pluginId: "audit",
                installedVersion: committed ? "1.0.0" : "0.9.0",
                record: committed ? currentRecords.audit : priorRecords.audit,
              }),
              acquirePackageLease: () => ({ heartbeat: () => {}, release: () => {} }),
              preflightPlugin: (params) =>
                preflightPluginInstall({
                  ...params,
                  loadInstallRecords: async () => ({
                    audit: { source: "clawhub", clawhubPackage: "audit", version: "0.9.0" },
                  }),
                }),
              inspectPluginCapabilities: () => emptyPluginCapabilityEvidence,
              probePlugin: async (params) => {
                const probeTarget = path.join(
                  params.extensionsDir ?? path.dirname(targetDir),
                  "audit",
                );
                const available = await ensureInstallTargetAvailable({
                  targetDir: probeTarget,
                  mode: params.mode ?? "install",
                  alreadyExistsError: "plugin already exists",
                });
                if (!available.ok) {
                  return available;
                }
                await params.onPluginArtifactInspect?.({
                  pluginId: "audit",
                  stagedArtifactDir: probeTarget,
                  mode: "update",
                });
                return {
                  ok: true,
                  pluginId: "audit",
                  packageName: "audit",
                  targetDir: probeTarget,
                  extensions: [],
                  clawhub: {
                    source: "clawhub",
                    clawhubFamily: "code-plugin",
                    clawhubUrl: "https://clawhub.ai",
                    clawhubPackage: "audit",
                    integrity,
                  },
                };
              },
            },
          },
        );
        if (directReinstall) {
          await expect(pending).rejects.toMatchObject({ partial: false });
          expect(committed).toBe(false);
          expect(uninstallPlugin).not.toHaveBeenCalled();
          expect(reloadPlugins).not.toHaveBeenCalled();
        } else if (lateFailure) {
          const error = await pending.catch((reason: unknown) => reason);
          expect(uninstallPlugin).not.toHaveBeenCalled();
          expect(error).toMatchObject({ partial: true, cause: { cause: failure } });
        } else {
          await expect(pending).resolves.toMatchObject({ appliedIds: ["plugin:audit"] });
        }
        expect(installPlugin).toHaveBeenCalledOnce();
        expect(uninstallPlugin).not.toHaveBeenCalled();
        expect(reloadPlugins).toHaveBeenCalledTimes(directReinstall ? 0 : 1);
      });
    },
  );

  it("rejects an owned plugin upgrade when another owner appears before install", async () => {
    const previous = ref("plugin", "audit", "0.9.0");
    const other = { ...previous, agentId: "other" };
    const preflightPlugin = vi.fn(async () => ({
      ok: false as const,
      code: "plugin_version_conflict" as const,
      request: {} as never,
      installedVersion: "0.9.0",
      expectedVersion: "1.0.0",
    }));
    const installPackages = vi.fn(
      async (_plan: ClawAddPlan, options: Parameters<typeof installClawPackages>[1]) => {
        expect(options).toBeDefined();
        const preflight = await options!.deps?.preflightPlugin?.({
          clawhubPackage: "audit",
          rawSpec: "clawhub:audit@1.0.0",
          expectedVersion: "1.0.0",
        });
        if (!preflight?.ok) {
          throw new Error("plugin version conflict");
        }
        return [ref("plugin", "audit", "1.0.0")];
      },
    );
    let reads = 0;
    const readRefs = vi.fn((options?: { agentId?: string }) => {
      reads += 1;
      if (options?.agentId) {
        return [previous];
      }
      return reads >= 3 ? [previous, other] : [previous];
    });

    await expect(
      applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "plugin:audit",
            action: "change",
            target: "clawhub:audit@1.0.0",
            blocked: false,
            reason: "owned upgrade",
          },
        ]),
        addPlan,
        {
          installPackages,
          readRefs,
          replaceExpected: vi.fn(),
          packageDeps: { preflightPlugin },
        },
      ),
    ).rejects.toMatchObject({ partial: false });
  });

  it("does not invoke an installer when package ownership changes after planning", async () => {
    const oldSkill = ref("skill", "triage", "1.0.0");
    const installPackages = vi.fn();
    const replaceExpected = vi.fn(() => {
      throw new Error('Package reference "skill:triage" changed after planning.');
    });

    await expect(
      applyClawPackageUpdate(
        plan([
          {
            kind: "package",
            id: "skill:triage",
            action: "change",
            target: "clawhub:triage@2.0.0",
            blocked: false,
            reason: "changed",
          },
        ]),
        addPlan,
        { installPackages, readRefs: () => [oldSkill], replaceExpected },
      ),
    ).rejects.toMatchObject({ partial: false });
    expect(installPackages).not.toHaveBeenCalled();
  });
});
