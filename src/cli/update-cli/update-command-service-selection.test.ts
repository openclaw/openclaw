import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveConfigPath, resolveStateDir } from "../../config/paths.js";
import * as service from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import * as shared from "./shared.js";
import {
  resolveUpdateCommandAdmissionEnv,
  resolveUpdateCommandAdmissionRoot,
} from "./update-command-admission-env.js";
import { prepareUpdateCommand } from "./update-command-run.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  { platform: "linux", fault: "missing manager UID" },
  { platform: "linux", fault: "invalid manager UID" },
  { platform: "linux", fault: "oversized command" },
  { platform: "darwin", fault: "oversized command" },
  { platform: "linux", fault: "none" },
  { platform: "darwin", fault: "none" },
  { platform: "linux", fault: "sealed definition" },
  { platform: "linux", fault: "source checkout" },
] as const)(
  "keeps the invoking install while selecting only verified service state ($platform, $fault)",
  async ({ platform, fault }) => {
    const home = tempDirs.make("openclaw-service-selection-");
    const requested = path.join(home, "current", "lib", "node_modules", "openclaw");
    const recorded = path.join(home, "old", "lib", "node_modules", "openclaw");
    const recordedNode = path.join(home, "old", "bin", "node");
    const recordedState = path.join(home, ".openclaw-recorded");
    await Promise.all([writePackageRoot(requested, "1.0.0"), writePackageRoot(recorded, "1.0.0")]);
    if (fault === "source checkout") {
      await fs.writeFile(path.join(recorded, ".git"), "gitdir: fixture\n");
      await fs.mkdir(path.join(recorded, "src"));
      await fs.mkdir(path.join(recorded, "extensions"));
    }
    await withEnvAsync(
      {
        HOME: home,
        OPENCLAW_HOME: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_UPDATE_POST_CORE: undefined,
        OPENCLAW_UPDATE_RUN_ID: undefined,
        [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: undefined,
      },
      async () => {
        mockProcessPlatform(platform);
        mockSystemAccountHome();
        vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(requested);
        const native = createMockGatewayService({
          isLoaded: async () => true,
          readCommand: async () => ({
            programArguments: [recordedNode, path.join(recorded, "dist", "index.js"), "gateway"],
            environment: {
              OPENCLAW_PROFILE: "recorded",
              OPENCLAW_STATE_DIR: recordedState,
              OPENCLAW_CONFIG_PATH: path.join(recordedState, "openclaw.json"),
              ...(fault === "oversized command" ? { PADDING: "x".repeat(4 * 1024 * 1024) } : {}),
            },
          }),
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

        const prepared = await prepareUpdateCommand({ dryRun: true });
        const root = prepared.servicePlan?.rootRedirect?.root ?? prepared.discoveredRoot;
        const admissionRoot = resolveUpdateCommandAdmissionRoot(prepared);
        const env = await resolveUpdateCommandAdmissionEnv({ root: admissionRoot, opts: {} });
        const sealed = fault === "sealed definition";
        const selected = fault === "none" || sealed;
        const state = selected ? recordedState : path.join(home, ".openclaw");
        expect
          .soft({
            root,
            admissionRoot,
            rebindRoot: prepared.servicePlan?.serviceRoot,
            node: prepared.servicePlan?.nodeRunner,
            state: resolveStateDir(env),
            config: resolveConfigPath(env),
          })
          .toEqual({
            root: sealed ? recorded : requested,
            admissionRoot: selected ? recorded : requested,
            rebindRoot: selected && !sealed ? recorded : undefined,
            node: selected ? recordedNode : undefined,
            state,
            config: path.join(state, "openclaw.json"),
          });
        const inspection = await maybeStopManagedServiceBeforeMutableUpdate({
          root: admissionRoot,
          updateInstallKind: "package",
          shouldRestart: true,
          phase: "inspect",
          jsonMode: true,
        });
        const foreign = fault === "source checkout";
        expect(inspection.serviceUpdateVerdict?.kind).toBe(
          foreign ? "foreign" : selected ? "owned" : "unavailable",
        );
        if (selected) {
          expect(inspection.serviceUpdateVerdict).toMatchObject({
            root: recorded,
            refreshDefinition: !sealed,
          });
        }
        if (!selected && !foreign) {
          expect(inspection.serviceMutationSkipMessage).toContain(
            "Restart the Gateway you launched manually",
          );
          expect(inspection.serviceEnv).toBeUndefined();
        }
        expect(native.stop).not.toHaveBeenCalled();
        await expect(fs.stat(recordedState)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  },
);
