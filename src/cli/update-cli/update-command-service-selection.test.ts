import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MACOS_APP_INSTALL_OWNER_MARKER } from "../../commands/test-runtime-config-helpers.js";
import { resolveConfigPath, resolveStateDir } from "../../config/paths.js";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import * as service from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as supervision from "../../infra/gateway-supervision.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import * as shared from "./shared.js";
import {
  prepareUpdateCommand,
  resolveUpdateCommandAdmissionEnv,
  resolveUpdateCommandAdmissionRoot,
} from "./update-command-run.js";
import { withServiceHome } from "./update-command-service-home.test-support.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";
import { resolveManagedServicePackageUpdatePlan } from "./update-command-service-plan.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
type Scenario = {
  platform: NodeJS.Platform;
  fault?: string;
  runtime?: "node" | "bun";
  definition?: "plain" | "empty" | "managedDefinition" | "managedOverrides";
  sameRoot?: boolean;
};
const cases: Scenario[] = [
  { platform: "linux", fault: "missing manager UID" },
  { platform: "linux", fault: "invalid manager UID" },
  { platform: "linux", fault: "oversized command" },
  { platform: "linux" },
  { platform: "darwin" },
  { platform: "linux", fault: "sealed definition" },
  { platform: "linux", fault: "source checkout" },
  { platform: "win32" },
  { platform: "win32", sameRoot: true },
  { platform: "linux", definition: "managedOverrides" },
  { platform: "linux", definition: "managedDefinition" },
  { platform: "linux", definition: "empty" },
  { platform: "linux", definition: "empty", runtime: "bun" },
  { platform: "linux", fault: "app owner" },
  { platform: "linux", fault: "app owner", runtime: "bun" },
  { platform: "linux", fault: "management refused" },
];

it.each(cases)(
  "selects verified service state: %j",
  ({ platform, fault, runtime = "node", definition = "plain", sameRoot }) =>
    withServiceHome(async (home) => {
      const recorded = path.join(home, "service");
      const requested = sameRoot ? recorded : path.join(home, "invoking");
      const recordedNode = path.join(home, "bin", runtime);
      const entrypoint = path.join(recorded, "dist", "index.js");
      const recordedState = path.join(home, ".openclaw-recorded");
      for (const root of new Set([requested, recorded])) {
        await writePackageRoot(root, "1.0.0");
      }
      if (fault === "source checkout") {
        await fs.writeFile(path.join(recorded, ".git"), "gitdir: fixture\n");
        await Promise.all(["src", "extensions"].map((dir) => fs.mkdir(path.join(recorded, dir))));
      }
      if (fault === "app owner") {
        await fs.writeFile(
          path.join(recorded, "openclaw-install-owner.json"),
          MACOS_APP_INSTALL_OWNER_MARKER,
        );
      }
      for (const key of [
        "OPENCLAW_UPDATE_POST_CORE",
        "OPENCLAW_UPDATE_RUN_ID",
        CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
      ]) {
        vi.stubEnv(key, undefined);
      }
      mockProcessPlatform(platform);
      mockSystemAccountHome();
      vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(requested);
      const pin = vi
        .spyOn(runtimePaths, "resolvePinnedDaemonRuntimePath")
        .mockImplementation(async (value) => value);
      const command = {
        programArguments: [recordedNode, entrypoint, "gateway"],
        environment: {
          OPENCLAW_PROFILE: "recorded",
          OPENCLAW_STATE_DIR: recordedState,
          OPENCLAW_CONFIG_PATH: path.join(recordedState, "openclaw.json"),
          ...(runtime === "bun" ? { OPENCLAW_SQLITE_LIBRARY: "/fixture/sqlite.dylib" } : {}),
          ...(fault === "oversized command" ? { PADDING: "x".repeat(4 * 1024 * 1024) } : {}),
        },
        ...(platform === "win32" ? { sourcePath: path.join(home, "gateway.cmd") } : {}),
      };
      const native = createMockGatewayService({
        isLoaded: async () => true,
        readCommand: vi.fn(async () => ({
          ...command,
          ...(definition === "empty" || definition === "managedDefinition"
            ? { managedDefinition: command }
            : {}),
          ...(definition === "empty" ? { managedOverrides: {} } : {}),
          ...(definition === "managedOverrides"
            ? { managedOverrides: { environment: { keys: ["OPENCLAW_PROFILE"] } } }
            : {}),
        })),
        readRuntime: async () => ({
          status: "stopped",
          systemd: {
            managerUid:
              fault === "missing manager UID"
                ? undefined
                : fault === "invalid manager UID"
                  ? -1
                  : 2001,
          },
        }),
        readDefinitionMutationCapability: async () =>
          fault === "sealed definition"
            ? { kind: "sealed", reason: "foreign-owner" }
            : { kind: "writable" },
      });
      vi.spyOn(service, "resolveGatewayService").mockReturnValue(native);
      if (fault === "management refused") {
        vi.spyOn(supervision, "assertGatewayServiceMutationAllowed").mockImplementation(() => {
          throw new Error("fixture supervisor owns service");
        });
        expect(await resolveManagedServicePackageUpdatePlan({ root: requested })).toEqual({
          rootRedirect: null,
          serviceUnitTarget: "not inspected (service management unavailable)",
        });
        expect(native.readCommand).not.toHaveBeenCalled();
        return;
      }
      if (fault === "app owner") {
        await expect(prepareUpdateCommand({ dryRun: true })).rejects.toMatchObject({
          name: "GatewayServiceUpdateOwnershipError",
          message: "Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.",
          failureFacts: [expect.objectContaining({ code: "service-mutation-refused" })],
        });
        expect(pin).not.toHaveBeenCalled();
        return;
      }
      const prepared = await prepareUpdateCommand({ dryRun: true });
      const admissionRoot = resolveUpdateCommandAdmissionRoot(prepared);
      const env = await resolveUpdateCommandAdmissionEnv({ root: admissionRoot, opts: {} });
      const selected = !fault || fault === "sealed definition";
      const rebind =
        selected &&
        !sameRoot &&
        runtime === "node" &&
        platform !== "win32" &&
        fault !== "sealed definition" &&
        (definition === "plain" || definition === "empty");
      const redirect = selected && !sameRoot && !rebind;
      const state = selected ? recordedState : path.join(home, ".openclaw");
      expect({
        root: prepared.servicePlan?.rootRedirect?.root ?? prepared.discoveredRoot,
        admissionRoot,
        rebindRoot: prepared.servicePlan?.serviceRoot,
        node: prepared.servicePlan?.nodeRunner,
        state: resolveStateDir(env),
        config: resolveConfigPath(env),
      }).toEqual({
        root: redirect ? recorded : requested,
        admissionRoot: selected ? recorded : requested,
        rebindRoot: rebind ? recorded : undefined,
        node: selected ? recordedNode : undefined,
        state,
        config: path.join(state, "openclaw.json"),
      });
      if (selected) {
        expect(prepared.servicePlan?.rootRedirect).toEqual(
          redirect ? { root: recorded, previousRoot: requested } : null,
        );
        expect(prepared.servicePlan?.serviceUnitTarget).toBe(entrypoint);
      }
      const inspection = await maybeStopManagedServiceBeforeMutableUpdate({
        root: admissionRoot,
        updateInstallKind: "package",
        shouldRestart: true,
        phase: "inspect",
        jsonMode: true,
      });
      expect(inspection.serviceUpdateVerdict?.kind).toBe(
        fault === "source checkout" ? "foreign" : selected ? "owned" : "unavailable",
      );
      if (selected) {
        expect(inspection.serviceUpdateVerdict).toMatchObject({
          root: recorded,
          refreshDefinition: fault !== "sealed definition",
        });
      } else if (fault !== "source checkout") {
        expect(inspection.serviceMutationSkipMessage).toContain("openclaw gateway stop");
        expect(inspection.serviceEnv).toBeUndefined();
      }
      expect(native.stop).not.toHaveBeenCalled();
      await expect(fs.stat(recordedState)).rejects.toMatchObject({ code: "ENOENT" });
    }),
);
