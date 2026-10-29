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

// Diagnostic-only: never serialize input objects or free-form strings. Bound all
// collections and fail closed on getters/proxies; cycles are never traversed.
function boundaryDiagnostic(
  drift: unknown,
  earlySucceeded: unknown,
  captures: unknown,
  calls: unknown,
  errors: unknown = [],
) {
  const count = (value: unknown): number => {
    const length: unknown = Array.isArray(value) ? value.length : 0;
    return typeof length === "number" && Number.isSafeInteger(length) && length >= 0
      ? Math.min(length, 32)
      : 0;
  };
  const field = (value: unknown, key: string): unknown =>
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)[key]
      : undefined;
  const reason = (value: unknown) => {
    switch (value) {
      case "managed-service-preflight":
      case "node-runtime-missing":
      case "node-runtime-incompatible":
      case "engine-incompatible":
      case "installation-unclassified":
      case "database-preflight":
        return value;
      default:
        return "other";
    }
  };
  const status = (value: unknown) => {
    switch (value) {
      case "ok":
      case "error":
      case "skipped":
      case "refused":
        return value;
      default:
        return "other";
    }
  };
  try {
    const reports: {
      reason: ReturnType<typeof reason>;
      status: ReturnType<typeof status>;
      steps: number;
      warnings: number;
      facts: number;
    }[] = [];
    let hasTypeError = false;
    let hasModuleNotFound = false;
    let hasSqliteError = false;
    let hasFixtureCaptureStop = false;
    for (let index = 0; index < count(errors); index++) {
      const error = field(field(errors, String(index)), "0");
      if (typeof error === "string") {
        hasTypeError ||= error.includes("TypeError");
        hasModuleNotFound ||=
          error.includes("ERR_MODULE_NOT_FOUND") || error.includes("Cannot find module");
        hasSqliteError ||= error.includes("SQLITE_");
        hasFixtureCaptureStop ||= error.includes(
          "Fixture stops best-effort capture after injecting drift",
        );
      }
    }
    for (let index = 0; index < count(calls); index++) {
      const report = field(field(calls, String(index)), "0");
      const steps = field(report, "steps");
      let warnings = count(field(report, "warnings"));
      let facts = count(field(report, "failureFacts"));
      for (let step = 0; step < count(steps); step++) {
        const entry = field(steps, String(step));
        warnings += count(field(entry, "warnings"));
        facts += count(field(entry, "failureFacts"));
      }
      reports.push({
        reason: reason(field(report, "reason")),
        status: status(field(report, "status")),
        steps: count(steps),
        warnings,
        facts,
      });
    }
    return {
      drift:
        drift === "permission" || drift === "definition" || drift === "executable"
          ? drift
          : "other",
      earlySucceeded: earlySucceeded === true,
      // Reached only after the unchanged code:1 rejection assertion succeeds.
      expectedCode1: true,
      captures: count(captures),
      captureCountCapped: count(captures) === 32,
      reportCountCapped: count(calls) === 32,
      reports,
      errors: count(errors),
      errorCountCapped: count(errors) === 32,
      hasTypeError,
      hasModuleNotFound,
      hasSqliteError,
      hasFixtureCaptureStop,
      projectionFailed: false,
    };
  } catch {
    return { projectionFailed: true };
  }
}

it("keeps boundary diagnostics allowlisted for hostile and cyclic input", () => {
  const secret = "/private/runner/token-DO-NOT-EMIT";
  const cyclic: Record<string, unknown> = {
    reason: secret,
    status: secret,
    root: secret,
    pid: 1234567,
    freeBytes: 987654321,
  };
  cyclic.self = cyclic;
  cyclic.toJSON = () => {
    throw new Error(secret);
  };
  cyclic.steps = [{ warnings: [secret], failureFacts: [{ message: secret }] }];
  const projected = boundaryDiagnostic(secret, true, [[]], [[cyclic]]);
  expect(projected).toEqual({
    drift: "other",
    earlySucceeded: true,
    expectedCode1: true,
    captures: 1,
    captureCountCapped: false,
    reportCountCapped: false,
    reports: [{ reason: "other", status: "other", steps: 1, warnings: 1, facts: 1 }],
    errors: 0,
    errorCountCapped: false,
    hasTypeError: false,
    hasModuleNotFound: false,
    hasSqliteError: false,
    hasFixtureCaptureStop: false,
    projectionFailed: false,
  });
  expect(JSON.stringify(projected)).not.toContain(secret);
  expect(JSON.stringify(projected)).not.toContain("1234567");
  expect(JSON.stringify(projected)).not.toContain("987654321");
  expect(
    boundaryDiagnostic(
      "executable",
      false,
      [],
      [],
      [[secret + " TypeError SQLITE_BUSY ERR_MODULE_NOT_FOUND"]],
    ),
  ).toMatchObject({ hasTypeError: true, hasModuleNotFound: true, hasSqliteError: true });
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error(secret);
      },
    },
  );
  expect(boundaryDiagnostic("permission", false, [], [[hostile]])).toEqual({
    projectionFailed: true,
  });
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  expect(boundaryDiagnostic("permission", false, revoked.proxy, [])).toEqual({
    projectionFailed: true,
  });
  expect(
    boundaryDiagnostic(
      "definition",
      false,
      [],
      [[{ reason: "managed-service-preflight", status: "error" }]],
    ),
  ).toMatchObject({
    drift: "definition",
    reports: [{ reason: "managed-service-preflight", status: "error" }],
  });
});

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
    try {
      console.error(
        "BOUNDARY_DIAGNOSTIC",
        JSON.stringify(
          boundaryDiagnostic(
            drift,
            earlySucceeded,
            capture.mock.calls,
            vi.mocked(defaultRuntime.writeJson).mock.calls,
            vi.mocked(defaultRuntime.error).mock.calls,
          ),
        ),
      );
    } catch {
      // Diagnostics must never replace the original assertion failure.
    }
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
