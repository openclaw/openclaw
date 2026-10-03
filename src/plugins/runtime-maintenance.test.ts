import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
import type { PluginRuntimeMaintenanceContextV1 } from "./runtime-maintenance-types.js";
import { runPluginRuntimeMaintenance } from "./runtime-maintenance.js";

vi.mock("./plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const registry = vi.mocked(loadPluginManifestRegistryForPluginRegistry);

function fixture(version = "one") {
  const root = tempDirs.make("openclaw-runtime-maintenance-");
  const artifact = path.join(root, "doctor-health-api.cjs");
  const write = (label: string) =>
    fs.writeFileSync(
      artifact,
      `exports.createPluginRuntimeMaintenanceChecksV1 = authority => {
        let repaired = false;
        return [{
          id: "example/runtime", kind: "plugin", description: "Example runtime",
          async detect(ctx) {
            await ctx.runtime.log(authority);
            return repaired ? [] : [{checkId: "example/runtime", severity: "warning", message: "Needs update"}];
          },
          async repair() {
            authority.assertCurrent();
            repaired = true;
            return {changes: [${JSON.stringify(label)}]};
          }
        }];
      };`,
    );
  write(version);
  const owner = createPluginManifestRecordFixture({
    id: "example",
    rootDir: root,
    source: artifact,
    origin: "global",
    trustedOfficialInstall: true,
    doctorHealthChecks: true,
  });
  registry.mockReturnValue({ plugins: [owner], diagnostics: [] });
  return { owner, write };
}

describe("explicit plugin runtime maintenance", () => {
  beforeEach(() => registry.mockReset());

  it("loads fresh artifact code and revokes retained authority after each operation", async () => {
    const { write } = fixture();
    const log = vi.fn<(value: unknown) => void>();
    const run = () =>
      runPluginRuntimeMaintenance({
        operation: "update",
        config: {},
        pluginIds: ["example"],
        signal: new AbortController().signal,
        assertCurrent: () => {},
        runtime: { log },
      });
    expect(await run()).toEqual([]);
    const first = log.mock.calls[0]![0] as PluginRuntimeMaintenanceContextV1;
    expect(first.signal.aborted).toBe(true);
    expect(() => first.assertCurrent()).toThrow();
    expect(log).toHaveBeenCalledWith("one");
    write("two");
    expect(await run()).toEqual([]);
    expect(log).toHaveBeenCalledWith("two");
    expect(registry).toHaveBeenCalledWith(
      expect.objectContaining({ pluginIds: ["example"], allowCurrent: false }),
    );
  });

  it("propagates revoked ownership even when the repair runner catches it", async () => {
    fixture();
    const error = new Error("caller revoked");
    let revoked = false;
    await expect(
      runPluginRuntimeMaintenance({
        operation: "install",
        config: {},
        signal: new AbortController().signal,
        assertCurrent: () => {
          if (revoked) {
            throw error;
          }
        },
        runtime: {
          log: () => {
            revoked = true;
          },
        },
      }),
    ).rejects.toBe(error);
  });

  it("cannot report completion when a health check catches uncertain native cleanup", async () => {
    fixture();
    await expect(
      runPluginRuntimeMaintenance({
        operation: "update",
        config: {},
        signal: new AbortController().signal,
        assertCurrent: () => {},
        runtime: {
          log: () => {
            // A consumer may catch the rejection, but the enclosing operation
            // must still retain the native process scope's cleanup failure.
            void withCommandProcessScope(async () => {
              throw new CommandProcessCleanupError();
            }).catch(() => {});
          },
        },
      }),
    ).rejects.toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
  });

  it.each(["untrusted", "undeclared", "unselected", "rehearsal"] as const)(
    "does not execute %s runtime maintenance",
    async (reason) => {
      const { owner } = fixture();
      if (reason === "untrusted") {
        owner.trustedOfficialInstall = false;
      }
      if (reason === "undeclared") {
        owner.doctorHealthChecks = false;
      }
      const log = vi.fn();
      await runPluginRuntimeMaintenance({
        operation: "update",
        config: {},
        pluginIds: reason === "unselected" ? [] : ["example"],
        signal: new AbortController().signal,
        assertCurrent: () => {},
        runtime: { log },
        ...(reason === "rehearsal"
          ? {
              env: {
                ...buildUpdateRehearsalPathEnv(owner.rootDir),
                OPENCLAW_UPDATE_IN_PROGRESS: "1",
                OPENCLAW_SERVICE_REPAIR_POLICY: "external",
                OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
                OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
              },
            }
          : {}),
      });
      expect(log).not.toHaveBeenCalled();
    },
  );
});
