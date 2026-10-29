import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import * as metadata from "../../infra/update-check-package-target.js";
import * as baseline from "../../infra/update-recovery-baseline-capture.js";
import { defaultRuntime } from "../../runtime.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import * as shared from "./shared.js";
import { UpdatePreMutationError } from "./shared.js";
import * as databaseContext from "./update-command-database-context.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as recovery from "./update-command-node-runtime-resolution.js";
import * as runtimeOwner from "./update-command-node-runtime.js";
import * as packageUpdate from "./update-command-package.js";
import * as admission from "./update-command-runtime-admission.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();
it.each(["installed", undefined] as const)(
  "rechecks current-Node authority before staging with %s admission",
  async (owner) => {
    vi.mocked(metadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      ...targetMetadata,
      nodeEngine: ">=26.12.1",
    });
    const recheck = vi.fn(async () => {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        "authority changed before staging",
      );
    });
    vi.spyOn(admission, "inspectPackageEngineAdmission").mockResolvedValue({
      runtime: {
        ok: true,
        value: { nodeRunner: process.execPath, replacedNodeRunner: "/old/node" },
      },
      assertCurrent: recheck,
    });
    const provision = vi.spyOn(recovery, "resolveTargetNodeRuntime");
    await expect(
      updateCommand({ tag: targetMetadata.version, yes: true, json: true, admission: owner }),
    ).rejects.toMatchObject({ code: 1 });
    expect(recheck).toHaveBeenCalled();
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "managed-service-preflight", root: fixture.root }),
    );
  },
);

it.each(["permission", "definition", "executable"] as const)(
  "initialized forced-installed retains original admission after late %s drift",
  async (drift) => {
    openOpenClawStateDatabase();
    closeOpenClawStateDatabaseForTest();
    expect(fs.existsSync(fixture.databasePath)).toBe(true);
    const oldNode = path.join(fixture.root, "old-node");
    const currentNode = path.join(fixture.root, "current-node");
    fs.writeFileSync(oldNode, "old", { mode: 0o700 });
    fs.writeFileSync(currentNode, "original", { mode: 0o700 });
    fixture.managedServiceNodeRunner = oldNode;
    const service: PreManagedServiceStop = {
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: true,
      serviceNodeRunner: oldNode,
      serviceEnv: { ...process.env },
      serviceUpdateVerdict: {
        kind: "owned",
        root: fixture.root,
        fingerprint: "original",
        refreshDefinition: true,
      },
    };
    vi.spyOn(servicePlan, "isGatewayServiceManagementAllowedForUpdate").mockReturnValue(true);
    vi.spyOn(databaseContext, "inspectUpdateManagedServices").mockImplementation(async () => ({
      service,
      services: new Map([[fixture.root, service]]),
      managedEnv: undefined,
    }));
    vi.spyOn(shared, "resolveNodeRunner").mockReturnValue(currentNode);
    vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo").mockImplementation(async (node) => ({
      status: "supported",
      version: node === oldNode ? "24.22.1" : "26.12.1",
      sqliteVersion: "3.53.0",
      nodeSharedSqlite: false,
      sqliteProbe: { available: true, version: "3.53.0", text: true, blob: true, json: true },
    }));
    vi.mocked(metadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      ...targetMetadata,
      nodeEngine: ">=26.12.1",
    });
    const actualAdmission = admission.inspectPackageEngineAdmission;
    let earlySucceeded = false;
    vi.spyOn(admission, "inspectPackageEngineAdmission").mockImplementation(async (params) => {
      // Model Node-only fallback during admission without changing the actual
      // Bun executable/identity used by initialized-state workers afterward.
      const versions = vi.spyOn(process, "versions", "get").mockReturnValue({
        ...process.versions,
        bun: undefined,
      });
      let retained: Awaited<ReturnType<typeof actualAdmission>>;
      try {
        retained = await actualAdmission(params);
      } finally {
        versions.mockRestore();
      }
      expect(retained.runtime.ok).toBe(true);
      return {
        ...retained,
        assertCurrent: async () => {
          await retained.assertCurrent();
          earlySucceeded = true;
        },
      };
    });
    const capture = vi
      .spyOn(baseline, "captureUpdateRecoveryBaseline")
      .mockImplementation(async () => {
        expect(earlySucceeded).toBe(true);
        if (service.serviceUpdateVerdict?.kind !== "owned") {
          throw new Error("fixture");
        }
        if (drift === "permission") {
          service.serviceUpdateVerdict.refreshDefinition = false;
        }
        if (drift === "definition") {
          service.serviceUpdateVerdict.fingerprint = "changed";
        }
        if (drift === "executable") {
          const replacement = path.join(fixture.root, "replacement-node");
          fs.writeFileSync(replacement, "compatible replacement", { mode: 0o700 });
          fs.renameSync(replacement, currentNode);
        }
        throw new Error("Fixture stops best-effort capture after injecting drift");
      });
    const provision = vi.spyOn(recovery, "resolveTargetNodeRuntime");
    const install = vi.spyOn(packageUpdate, "runPackageInstallUpdate");
    const prepareRuntime = vi.spyOn(runtimeOwner, "preparePackageUpdateRuntime");
    await expect(
      updateCommand({ tag: targetMetadata.version, yes: true, json: true, admission: "installed" }),
    ).rejects.toMatchObject({ code: 1 });
    expect(capture).toHaveBeenCalledOnce();
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(prepareRuntime).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "managed-service-preflight" }),
    );
  },
);
