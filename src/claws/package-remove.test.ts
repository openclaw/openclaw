import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { ok } from "@openclaw/normalization-core/result";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import { applyClawHubSkillUninstall } from "../skills/lifecycle/clawhub-uninstall.js";
import { digestClawHubSkillTree } from "../skills/lifecycle/skill-tree-digest.js";
import {
  applyClawPackageRemovals,
  planClawPackageRemovals,
  type PackageRemovalDeps,
} from "./package-remove.js";
import type { PersistedClawInstall, PersistedClawPackageRef } from "./provenance.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const install = {
  workspace: "/tmp/claw-workspace",
} as PersistedClawInstall;

function packageRef(overrides: Partial<PersistedClawPackageRef> = {}): PersistedClawPackageRef {
  return {
    schemaVersion: "openclaw.clawPackageRef.v1",
    agentId: "worker",
    clawName: "@acme/worker",
    kind: "plugin",
    source: "clawhub",
    ref: "audit",
    version: "1.0.0",
    integrity: "sha256:audit",
    status: "complete",
    relationship: "referenced",
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function packageRefStore(...initial: PersistedClawPackageRef[]) {
  let refs = initial;
  return {
    acquirePackageLease: vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() })),
    readPackageRefs: vi.fn(() => refs),
    readInstallRecords: vi.fn(() => []),
    claimPackageRef: vi.fn(
      (ref: PersistedClawPackageRef, status: PersistedClawPackageRef["status"]) => {
        const claimed = { ...ref, status };
        refs = refs.map((candidate) =>
          candidate.agentId === ref.agentId &&
          candidate.kind === ref.kind &&
          candidate.source === ref.source &&
          candidate.ref === ref.ref &&
          candidate.version === ref.version
            ? claimed
            : candidate,
        );
        return claimed;
      },
    ),
  };
}

async function trackedQualifiedSkillFixture() {
  const workspaceDir = tempDirs.make("openclaw-claw-skill-remove-");
  const slug = "triage";
  const skillDir = join(workspaceDir, "skills", slug);
  const content = "---\nname: triage\ndescription: Triage incidents\n---\n";
  const sha256 = createHash("sha256").update(content).digest("hex");
  const installedAt = 1;
  const registry = "https://clawhub.ai";
  const ownerHandle = "owner";
  await mkdir(join(skillDir, ".clawhub"), { recursive: true });
  await mkdir(join(workspaceDir, ".clawhub"), { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), content);
  const fileTreeSha256 = await digestClawHubSkillTree(skillDir);
  const trackedMetadata = {
    registry,
    ownerHandle,
    installedAt,
    skillFile: { path: "SKILL.md", sha256 },
    fileTreeSha256,
  };
  await writeFile(
    join(skillDir, ".clawhub", "origin.json"),
    JSON.stringify({
      version: 1,
      slug,
      installedVersion: "1.0.0",
      ...trackedMetadata,
    }),
  );
  const lockPath = join(workspaceDir, ".clawhub", "lock.json");
  await writeFile(
    lockPath,
    JSON.stringify({
      version: 1,
      skills: {
        [slug]: {
          version: "1.0.0",
          ...trackedMetadata,
        },
      },
    }),
  );
  return { workspaceDir, slug, skillDir, lockPath };
}

describe("Claw package removal", () => {
  it.each(["lease lost during resolution", "uninstall failed"])(
    "keeps mutation and compensation with their current package owner: %s",
    async (failure) => {
      const ref = packageRef();
      const store = packageRefStore(ref);
      let leaseLost = false;
      const uninstallPlugin = vi.fn<NonNullable<PackageRemovalDeps["uninstallPlugin"]>>(
        async () => {
          if (failure === "uninstall failed") {
            throw new Error(failure);
          }
          return ok({
            pluginId: "audit",
            requestedPluginId: "audit",
            pluginIds: ["audit"],
            removed: [],
            warnings: [],
          });
        },
      );
      const heartbeat = () => {
        if (leaseLost) {
          throw new Error(failure);
        }
      };
      await expect(
        applyClawPackageRemovals(
          [
            {
              packageRef: ref,
              workspace: install.workspace,
              action: "uninstall",
              affectedClawAgentIds: [],
              pluginId: "audit",
            },
          ],
          {
            deps: {
              ...store,
              acquirePackageLease: vi.fn(() => ({ heartbeat, release: vi.fn() })),
              uninstallPlugin,
              resolvePlugin: vi.fn(async () => {
                leaseLost = failure === "lease lost during resolution";
                return {
                  status: "found" as const,
                  pluginId: "audit",
                  record: {
                    source: "clawhub" as const,
                    integrity: "sha256:audit",
                    installedAt: "1970-01-01T00:00:00.001Z",
                  },
                  installedVersion: "1.0.0",
                };
              }),
            },
          },
        ),
      ).resolves.toMatchObject({ packages: [{ action: "error", reason: failure }] });
      if (leaseLost) {
        expect(uninstallPlugin).not.toHaveBeenCalled();
        expect(store.readPackageRefs()[0]?.status).toBe("pending");
      } else {
        expect(uninstallPlugin).toHaveBeenCalledOnce();
        expect(store.readPackageRefs()[0]?.status).toBe("failed");
      }
    },
  );

  it.each([false, true])(
    "preserves partial package effects and stops only runtime failures (runtime=%s)",
    async (runtime) => {
      const refs = ["first", "failed", "last"].map((ref) =>
        packageRef({ ref, integrity: `sha256:${ref}` }),
      );
      const store = packageRefStore(...refs);
      const failure = runtime
        ? new PluginRuntimeApplicationError("Plugin activation failed.", {
            operationId: "replacement",
            generation: 3,
            pluginIds: ["failed"],
            phase: "activate",
            committed: true,
          })
        : new Error("Package removal failed.");
      const uninstallPlugin = vi.fn<NonNullable<PackageRemovalDeps["uninstallPlugin"]>>(
        async (input) => {
          input.onWarning?.(`${input.pluginId} cleanup warning`);
          if (input.pluginId === "failed") {
            throw failure;
          }
          return ok({
            pluginId: input.pluginId,
            requestedPluginId: input.pluginId,
            pluginIds: [input.pluginId],
            removed: ["directory"],
            warnings: [`${input.pluginId} cleanup warning`],
          });
        },
      );
      const result = await applyClawPackageRemovals(
        refs.map((ref) => ({
          packageRef: ref,
          workspace: install.workspace,
          action: "uninstall" as const,
          affectedClawAgentIds: [],
          pluginId: ref.ref,
        })),
        {
          deps: {
            ...store,
            uninstallPlugin,
            resolvePlugin: async ({ clawhubPackage }) => ({
              status: "found",
              pluginId: clawhubPackage,
              installedVersion: "1.0.0",
              record: {
                source: "clawhub",
                integrity: `sha256:${clawhubPackage}`,
                installedAt: "1970-01-01T00:00:00.001Z",
              },
            }),
          },
        },
      );
      expect(result.packages).toEqual([
        { kind: "plugin", ref: "first", version: "1.0.0", action: "uninstalled" },
        {
          kind: "plugin",
          ref: "failed",
          version: "1.0.0",
          action: "error",
          reason: failure.message,
        },
        {
          kind: "plugin",
          ref: "last",
          version: "1.0.0",
          action: runtime ? "retained" : "uninstalled",
          ...(runtime
            ? { reason: "Package cleanup stopped after a Gateway runtime replacement failed." }
            : {}),
        },
      ]);
      expect(result.runtimeFailure).toBe(runtime ? failure : undefined);
      expect(result.warnings).toEqual(
        runtime
          ? ["first cleanup warning", "failed cleanup warning"]
          : ["first cleanup warning", "failed cleanup warning", "last cleanup warning"],
      );
      expect(uninstallPlugin.mock.calls.map(([input]) => input.pluginId)).toEqual(
        runtime ? ["first", "failed"] : ["first", "failed", "last"],
      );
      expect(store.readPackageRefs().map((ref) => ref.status)).toEqual([
        "complete",
        "failed",
        "complete",
      ]);
      expect(store.claimPackageRef.mock.calls.some(([ref]) => ref.ref === "last")).toBe(!runtime);
    },
  );

  it("retains referenced plugins by default while releasing the Claw reference", async () => {
    const ref = packageRef();
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        resolvePlugin: vi.fn(),
      },
    });

    expect(decisions).toMatchObject([
      {
        action: "retain",
        reason:
          "Claw add introduced this shared requirement; removal releases its dependency edge and retains the artifact. Use its canonical owner separately to uninstall it.",
      },
    ]);
  });

  it("requires separate selection before invoking the canonical plugin lifecycle", async () => {
    const ref = packageRef();
    const store = packageRefStore(ref);
    const uninstallPlugin = vi.fn().mockResolvedValue(
      ok({
        pluginId: "audit",
        requestedPluginId: "audit",
        pluginIds: ["audit"],
        removed: [],
        warnings: [],
      }),
    );
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        ...store,
        resolvePlugin: vi.fn().mockResolvedValue({
          status: "found",
          pluginId: "audit",
          record: { source: "clawhub", integrity: "sha256:audit", installedAt: 1 },
          installedVersion: "1.0.0",
        }),
      },
      referencedCleanup: {
        mode: "remove-selected",
        selected: ["plugin:audit@1.0.0"],
      },
    });

    expect(decisions).toMatchObject([{ action: "uninstall", pluginId: "audit" }]);
    await expect(
      applyClawPackageRemovals(decisions, {
        deps: {
          ...store,
          uninstallPlugin,
          resolvePlugin: vi.fn().mockResolvedValue({
            status: "found",
            pluginId: "audit",
            record: { source: "clawhub", integrity: "sha256:audit", installedAt: 1 },
            installedVersion: "1.0.0",
          }),
        },
      }),
    ).resolves.toMatchObject({ packages: [{ action: "uninstalled" }] });
    expect(uninstallPlugin).toHaveBeenCalledWith({
      pluginId: "audit",
      caller: "cli",
      invalidateRuntimeCache: false,
      clawManaged: true,
      applyRuntime: undefined,
      beforePersistentApply: expect.any(Function),
      onWarning: expect.any(Function),
    });
  });

  it("excludes plugins from generic remove-if-unused cleanup", async () => {
    const ref = packageRef();
    const resolvePlugin = vi.fn();

    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        resolvePlugin,
      },
      referencedCleanup: { mode: "remove-if-unused" },
    });

    expect(decisions).toMatchObject([
      {
        action: "retain",
        reason:
          "Global plugins are excluded from generic remove-if-unused cleanup; select the plugin explicitly to invoke its canonical owner.",
      },
    ]);
    expect(resolvePlugin).not.toHaveBeenCalled();
  });

  it("rechecks plugin identity under the lifecycle lease before uninstalling", async () => {
    const ref = packageRef();
    const store = packageRefStore(ref);
    const uninstallPlugin = vi.fn();

    await expect(
      applyClawPackageRemovals(
        [
          {
            packageRef: ref,
            workspace: install.workspace,
            action: "uninstall",
            affectedClawAgentIds: [],
            pluginId: "audit",
          },
        ],
        {
          deps: {
            ...store,
            uninstallPlugin,
            resolvePlugin: vi.fn().mockResolvedValue({
              status: "found",
              pluginId: "replacement",
              record: { source: "clawhub", integrity: "sha256:replacement" },
              installedVersion: "2.0.0",
            }),
          },
        },
      ),
    ).resolves.toMatchObject({
      packages: [
        {
          action: "error",
          reason: "Plugin audit@1.0.0 changed after removal planning.",
        },
      ],
    });

    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(store.claimPackageRef).toHaveBeenLastCalledWith(
      expect.objectContaining({ ref: "audit" }),
      "complete",
      expect.anything(),
    );
  });

  it.each(["discovery", "uninstall"])(
    "refuses package mutations when parent deletion ends during %s",
    async (stage) => {
      const ref = packageRef();
      const store = packageRefStore(ref);
      const started = createDeferred();
      const resume = createDeferred();
      let active = true;
      const uninstall = vi.fn();
      const options = {
        assertCurrent: () => {
          if (!active) {
            throw new Error("Parent deletion ended.");
          }
        },
        deps: {
          ...store,
          resolvePlugin: vi.fn(async () => {
            if (stage === "discovery") {
              started.resolve();
              await resume.promise;
            }
            return {
              status: "found" as const,
              pluginId: "audit",
              record: {
                source: "clawhub" as const,
                integrity: "sha256:audit",
                installedAt: "1970-01-01T00:00:00.001Z",
              },
              installedVersion: "1.0.0",
            };
          }),
          uninstallPlugin: vi.fn<NonNullable<PackageRemovalDeps["uninstallPlugin"]>>(
            async (apply) => {
              if (stage === "uninstall") {
                started.resolve();
                await resume.promise;
              }
              apply?.beforePersistentApply?.();
              uninstall();
              return ok({
                pluginId: "audit",
                requestedPluginId: "audit",
                pluginIds: ["audit"],
                removed: [],
                warnings: [],
              });
            },
          ),
        },
      };
      const removing = applyClawPackageRemovals(
        [
          {
            packageRef: ref,
            workspace: install.workspace,
            action: "uninstall",
            affectedClawAgentIds: [],
            pluginId: "audit",
          },
        ],
        options,
      );
      try {
        await started.promise;
        active = false;
      } finally {
        resume.resolve();
      }

      await expect(removing).resolves.toMatchObject({
        packages: [{ action: "error", reason: "Parent deletion ended." }],
      });
      expect(uninstall).not.toHaveBeenCalled();
      expect(store.readPackageRefs()).toEqual([{ ...ref, status: "pending" }]);
    },
  );

  it("requires an explicit override to remove a selected shared reference", async () => {
    const ref = packageRef();
    const other = packageRef({ agentId: "other" });
    const deps = {
      readPackageRefs: vi.fn().mockReturnValue([ref, other]),
      resolvePlugin: vi.fn().mockResolvedValue({
        status: "found",
        pluginId: "audit",
        record: { source: "clawhub", integrity: "sha256:audit", installedAt: 1 },
        installedVersion: "1.0.0",
      }),
    };
    const selected = ["plugin:audit@1.0.0"];

    await expect(
      planClawPackageRemovals(install, [ref], {
        deps,
        referencedCleanup: { mode: "remove-selected", selected },
      }),
    ).resolves.toMatchObject([
      { action: "retain", blocked: true, affectedClawAgentIds: ["other"] },
    ]);
    await expect(
      planClawPackageRemovals(install, [ref], {
        deps,
        referencedCleanup: { mode: "remove-selected", selected, allowConflicts: true },
      }),
    ).resolves.toMatchObject([
      {
        action: "uninstall",
        allowConflicts: true,
        affectedClawAgentIds: ["other"],
      },
    ]);
  });

  it.each([
    ["independently-owned", packageRef({ independentOwner: true })],
    ["pending", packageRef({ status: "pending" })],
    ["shared", packageRef()],
  ])("retains %s artifacts while releasing the Claw reference", async (scenario, ref) => {
    const other = packageRef({ agentId: "other" });
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue(scenario === "shared" ? [ref, other] : [ref]),
        resolvePlugin: vi.fn(),
      },
    });
    expect(decisions).toMatchObject([{ action: "retain", reason: expect.any(String) }]);
  });

  it("retains a same-version plugin whose installed integrity drifted", async () => {
    const ref = packageRef({ relationship: "managed" });
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        resolvePlugin: vi.fn().mockResolvedValue({
          status: "found",
          pluginId: "audit",
          record: { source: "clawhub", integrity: "sha256:replacement" },
          installedVersion: "1.0.0",
        }),
      },
    });
    expect(decisions).toMatchObject([
      {
        action: "retain",
        reason: "Installed plugin changed after the Claw was added.",
      },
    ]);
  });

  it("retains a plugin reinstalled directly after Claw provenance", async () => {
    const ref = packageRef({ relationship: "managed", updatedAtMs: 10 });
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        resolvePlugin: vi.fn().mockResolvedValue({
          status: "found",
          pluginId: "audit",
          record: {
            source: "clawhub",
            integrity: "sha256:audit",
            installedAt: new Date(20).toISOString(),
          },
          installedVersion: "1.0.0",
        }),
      },
    });

    expect(decisions).toMatchObject([
      {
        action: "retain",
        reason: "Package has a current non-Claw owner or pre-existing origin.",
      },
    ]);
  });

  it("removes a persisted owner-qualified skill through its local install identity", async () => {
    const current = await trackedQualifiedSkillFixture();
    const currentInstall = { ...install, workspace: current.workspaceDir };
    const ref = packageRef({
      kind: "skill",
      ref: "@owner/triage",
      relationship: "managed",
    });
    const store = packageRefStore(ref);

    const decisions = await planClawPackageRemovals(currentInstall, [ref], {
      deps: store,
    });

    expect(decisions).toMatchObject([
      {
        action: "uninstall",
        skillPlan: {
          requestedRef: "@owner/triage",
          slug: "triage",
          targetDir: current.skillDir,
        },
      },
    ]);
    await expect(applyClawPackageRemovals(decisions, { deps: store })).resolves.toMatchObject({
      packages: [{ action: "uninstalled" }],
    });
    await expect(readFile(join(current.skillDir, "SKILL.md"), "utf8")).rejects.toThrow();
    const lock = JSON.parse(await readFile(current.lockPath, "utf8")) as {
      skills: Record<string, unknown>;
    };
    expect(lock.skills).toEqual({});
  });

  it.each(["preparation", "staged validation", "successor lease"])(
    "fences skill effects after ownership loss during %s",
    async (phase) => {
      const current = await trackedQualifiedSkillFixture();
      const currentInstall = { ...install, workspace: current.workspaceDir };
      const ref = packageRef({ kind: "skill", ref: "@owner/triage", relationship: "managed" });
      const store = packageRefStore(ref);
      const decisions = await planClawPackageRemovals(currentInstall, [ref], { deps: store });
      let owned = true;
      let retainedDir = current.skillDir;
      let packageOwned = true;
      const results = await applyClawPackageRemovals(decisions, {
        assertCurrent: () => {
          if (!owned) {
            throw new Error("removal superseded");
          }
        },
        deps: {
          ...store,
          acquirePackageLease: () => ({
            heartbeat() {
              if (!packageOwned) {
                throw new Error("Package lease superseded.");
              }
            },
            release() {},
          }),
          uninstallSkill: async (plan, options) => {
            const pending = applyClawHubSkillUninstall(plan, {
              ...options,
              rename: async (from, to) => {
                await rename(from, to);
                retainedDir = String(to);
                if (phase === "staged validation" || phase === "successor lease") {
                  owned = false;
                  if (phase === "successor lease") {
                    packageOwned = false;
                  }
                }
              },
            });
            if (phase === "preparation") {
              owned = false;
            }
            return await pending;
          },
        },
      });
      expect(results).toMatchObject({
        packages: [{ action: "error", reason: expect.stringContaining("removal superseded") }],
      });
      const expectedDir = phase === "successor lease" ? retainedDir : current.skillDir;
      await expect(readFile(join(expectedDir, "SKILL.md"), "utf8")).resolves.toContain(
        "name: triage",
      );
      const lock = JSON.parse(await readFile(current.lockPath, "utf8"));
      expect(lock.skills.triage).toBeDefined();
      expect(store.readPackageRefs()[0]?.status).toBe("pending");
    },
  );

  it("treats equal skill refs in separate agent workspaces as separate artifacts", async () => {
    const ref = packageRef({ kind: "skill", ref: "triage", relationship: "managed" });
    const other = packageRef({
      kind: "skill",
      ref: "triage",
      relationship: "managed",
      agentId: "other",
    });
    const skillPlan = {
      workspaceDir: install.workspace,
      requestedRef: "triage",
      slug: "triage",
      version: "1.0.0",
      installedAt: 1,
      targetDir: "/tmp/claw-workspace/skills/triage",
      skillFilePath: "SKILL.md",
      skillFileSha256: "abc",
      fileTreeSha256: "def",
    };
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref, other]),
        readInstallRecords: vi.fn().mockReturnValue([
          { ...install, agentId: "worker" },
          { ...install, agentId: "other", workspace: "/tmp/other-workspace" },
        ]),
        planSkill: vi.fn().mockResolvedValue({ ok: true, plan: skillPlan }),
      },
    });
    expect(decisions).toMatchObject([{ action: "uninstall", skillPlan }]);
  });

  it("retains a skill referenced by another Claw in the same workspace", async () => {
    const ref = packageRef({ kind: "skill", ref: "triage", relationship: "managed" });
    const other = packageRef({
      kind: "skill",
      ref: "triage",
      relationship: "managed",
      agentId: "other",
    });
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref, other]),
        readInstallRecords: vi.fn().mockReturnValue([
          { ...install, agentId: "worker" },
          { ...install, agentId: "other" },
        ]),
        planSkill: vi.fn(),
      },
    });

    expect(decisions).toMatchObject([
      { action: "retain", reason: "Another Claw still references this package." },
    ]);
  });

  it("retains an orphan skill when its workspace provenance is missing", async () => {
    const ref = packageRef({ kind: "skill", ref: "triage", relationship: "managed" });
    const planSkill = vi.fn();
    const decisions = await planClawPackageRemovals({ ...install, workspace: "" }, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref]),
        planSkill,
      },
    });

    expect(decisions).toMatchObject([
      { action: "retain", reason: "Skill workspace provenance is missing." },
    ]);
    expect(planSkill).not.toHaveBeenCalled();
  });

  it("releases a global plugin reference while another Claw is also being removed", async () => {
    const ref = packageRef();
    const other = packageRef({ agentId: "other" });
    const decisions = await planClawPackageRemovals(install, [ref], {
      deps: {
        readPackageRefs: vi.fn().mockReturnValue([ref, other]),
        resolvePlugin: vi.fn(),
      },
    });
    let refs = [ref, other];
    const claimPackageRef = vi.fn((claimedRef: PersistedClawPackageRef) => {
      refs = refs.map((candidate) => ({
        ...candidate,
        status: "pending" as const,
      }));
      return { ...claimedRef, status: "pending" as const };
    });

    await expect(
      applyClawPackageRemovals(decisions, {
        deps: {
          acquirePackageLease: vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() })),
          readPackageRefs: vi.fn(() => refs),
          claimPackageRef,
        },
      }),
    ).resolves.toMatchObject({ packages: [{ action: "retained" }] });
  });

  it("releases a reference whose independent ownership was derived from install time", async () => {
    const persisted = packageRef({ independentOwner: false });
    const derived = packageRef({ independentOwner: true });
    const store = packageRefStore(persisted);

    await expect(
      applyClawPackageRemovals(
        [
          {
            packageRef: derived,
            workspace: install.workspace,
            action: "retain",
            reason: "Package is independently owned outside this Claw.",
            affectedClawAgentIds: [],
          },
        ],
        { deps: store },
      ),
    ).resolves.toMatchObject({ packages: [{ action: "retained" }] });
  });
});
