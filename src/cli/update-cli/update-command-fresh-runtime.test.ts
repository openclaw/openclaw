import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import * as shared from "./shared.js";
import * as databaseContext from "./update-command-database-context.js";
import type { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

async function captureFreshManagedServiceAdmission(params: {
  root: string;
  owned: boolean;
  writable: boolean;
  restart: boolean;
}): Promise<Awaited<ReturnType<typeof inspectUpdateDatabaseContexts>>> {
  return {
    service: params.owned
      ? {
          stopped: false,
          inspected: true,
          runtimeInspected: true,
          running: true,
          serviceNodeRunner: "/service/node",
          serviceMutationAllowed: params.restart,
          serviceUpdateVerdict: {
            kind: "owned",
            root: params.root,
            fingerprint: "fixture",
            refreshDefinition: params.writable,
          },
        }
      : undefined,
    services: new Map(),
    contexts: [await captureTargetDatabaseSchemaContext(process.env)],
    managedEnv: undefined,
  };
}

// Discovery-known service runners stay protected when schema inspection has no service context.
const freshManagedServiceRuntimeCases = [
  // name, discovered, owned, writable, restart, fallback, recovery
  ["owned writable service", true, true, true, true, "/current/node", true],
  ["discovered service without inspected ownership", true, false, false, true, undefined, false],
  ["owned service with no restart", true, true, true, false, undefined, false],
  ["owned non-rewritable service", true, true, false, true, undefined, false],
  ["no discovered service with no restart", false, false, false, false, undefined, true],
] as const;

const { fixture } = installFreshUpdateFixture();

describe("update command admission with fresh state", () => {
  it.each(freshManagedServiceRuntimeCases)(
    "limits fresh-state Node recovery (%s)",
    async (_name, discovered, owned, writable, restart, expectedFallback, expectedRecovery) => {
      fixture.managedServiceNodeRunner = discovered ? "/service/node" : undefined;
      vi.spyOn(shared, "resolveNodeRunner").mockReturnValue("/current/node");
      vi.mocked(databaseContext.inspectUpdateDatabaseContexts).mockImplementation(() =>
        captureFreshManagedServiceAdmission({ root: fixture.root, owned, writable, restart }),
      );
      const runtimePreflight = vi
        .spyOn(servicePlan, "resolvePackageRuntimePreflight")
        .mockResolvedValue({ ok: false, error: "fixture-stop" });

      await expect(
        updateCommand({ admission: "installed", tag: "2026.9.2", yes: true, json: true, restart }),
      ).rejects.toMatchObject({ code: 1 });

      expect(runtimePreflight).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          nodeRunner: discovered ? "/service/node" : undefined,
          fallbackNodeRunner: process.versions.bun ? undefined : expectedFallback,
          runtimeRecovery: expectedRecovery ? expect.any(Object) : undefined,
        }),
      );
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", reason: "node-runtime-preflight" }),
      );
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
      expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
      expect(fs.readdirSync(fixture.root)).toEqual(["package.json"]);
    },
  );
});
