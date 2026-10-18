import { expect, it, vi } from "vitest";
import * as stateDatabase from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildClawRemovalFixture } from "./lifecycle-remove.test-support.js";
import { readClawPackageRemovalStatus } from "./lifecycle-status.js";
import {
  deleteClawInstallRecord,
  persistClawInstallRecord,
  persistClawPackageRef,
} from "./provenance.js";
import { upsertClawWorkspaceFile } from "./workspace.js";

it("reads current package ownership in the worker and preserves orphan workspace identity", async () => {
  await withOpenClawTestState({ label: "claw-package-status" }, async (state) => {
    const { plan } = await buildClawRemovalFixture(state.root);
    const options = { env: state.env };
    const install = persistClawInstallRecord(plan, options);
    const packageRef = persistClawPackageRef(
      plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "audit",
        version: "1.0.0",
        integrity: "sha256:audit",
      },
      { ...options, status: "pending", nowMs: 1234 },
    );
    upsertClawWorkspaceFile(
      {
        schemaVersion: "openclaw.clawWorkspaceFileRecord.v1",
        agentId: "worker",
        workspace: plan.agent.workspace,
        path: "SOUL.md",
        sourcePath: "SOUL.md",
        contentDigest: "sha256:fixture",
        status: "complete",
        createdAtMs: 1000,
        updatedAtMs: 2000,
      },
      options,
    );
    const read = async (agentId: string) => {
      const syncOpen = vi
        .spyOn(stateDatabase, "openOpenClawStateDatabase")
        .mockImplementation(() => {
          throw new Error("Claw status opened SQLite on the caller thread");
        });
      try {
        return await readClawPackageRemovalStatus(agentId, options);
      } finally {
        syncOpen.mockRestore();
      }
    };
    const expectedPackages = [
      {
        ...packageRef,
        state: "incomplete",
        message: "Package installation is incomplete.",
      },
    ];
    expect(await read("worker")).toEqual({ install, packages: expectedPackages });
    expect(await read("missing")).toBeUndefined();

    deleteClawInstallRecord("worker", options);
    const orphan = await read("worker");
    expect(orphan?.orphaned).toBe(true);
    expect(orphan?.packages).toEqual(expectedPackages);
    expect(orphan?.install).toMatchObject({
      agentId: "worker",
      workspace: plan.agent.workspace,
      claw: { name: plan.claw.name, integrity: "sha256:orphan" },
      status: "partial",
      updatedAtMs: 2000,
    });
  });
});
