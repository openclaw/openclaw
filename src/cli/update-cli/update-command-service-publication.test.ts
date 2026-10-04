import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runNodeMain } from "../../../test/scripts/run-node-boundary.test-support.js";
import * as serviceFiles from "../../daemon/inspect-files.js";
import { ServiceInspectionError } from "../../daemon/service-inspection-error.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as gatewayLocks from "../../infra/gateway-lock.js";
import { tryAcquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as portProbe from "../../infra/ports-probe.js";
import * as updateCheck from "../../infra/update-check.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  runOutsideOpenClawDatabaseMaintenanceScope,
} from "../../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { createUpdateCommandFailureResult } from "./update-command-result.js";
import { completeSourceUpdateRuntime } from "./update-command-runtime.js";
import { withServiceHome } from "./update-command-service-home.test-support.js";
import { withGatewayRuntimeArtifactPublication } from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({ service: vi.fn<() => GatewayService>() }));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));

beforeEach(() => mockSystemAccountHome());
afterEach(() => vi.restoreAllMocks());

async function withRuntimePublicationFixture(
  run: (fixture: {
    home: string;
    root: string;
    env: NodeJS.ProcessEnv;
    service: GatewayService;
    databasePath: string;
  }) => Promise<void>,
): Promise<void> {
  await withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    const root = path.join(home, "checkout");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.mkdir(path.join(root, "dist-runtime"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    await fs.writeFile(path.join(root, "dist", "entry.js"), "export {};\n");
    const env = { ...process.env };
    const service = createMockGatewayService({
      readCommand: vi.fn(async () => ({
        programArguments: [process.execPath, path.join(root, "dist", "entry.js"), "gateway"],
      })),
      readRuntime: vi.fn<GatewayService["readRuntime"]>(async () => ({
        status: "stopped",
        systemd: { managerUid: 2001 },
      })),
      isLoaded: vi.fn(async () => true),
      isEnabled: vi.fn(async () => false),
    });
    mocks.service.mockReturnValue(service);
    vi.spyOn(gatewayLocks, "readActiveGatewayLockIdentity").mockResolvedValue(undefined);
    vi.spyOn(portProbe, "probePortUsage").mockResolvedValue("free");
    await run({ home, root, env, service, databasePath: resolveOpenClawStateSqlitePath(env) });
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  });
}

it("keeps Task Scheduler timeout details in the source-build failure report", () =>
  withRuntimePublicationFixture(async ({ root, env, service }) => {
    vi.mocked(service.readCommand).mockRejectedValue(
      new ServiceInspectionError("windows-task-inspection-failed", {
        kind: "timeout",
        timeoutMs: 731,
      }),
    );
    const spawn = vi.fn();
    const error = await runNodeMain({ cwd: root, args: ["--version"], env, spawn }).catch(
      (caughtError: unknown) => caughtError,
    );
    const result = createUpdateCommandFailureResult({
      mode: "git",
      root,
      durationMs: 0,
      failure: { cause: error },
    });
    expect(result.reason).toBe("runtime-artifact-publication");
    expect(service.readCommand).toHaveBeenCalled();
    expect(result.failedStep.failureFacts?.[0]?.message).toContain("timed out after 731 ms");
    expect(spawn).not.toHaveBeenCalled();
  }));

it.each([undefined, "stale-profile"])(
  "preserves the serving installation and points back to the original doctor command (profile=%s)",
  (profile) =>
    withRuntimePublicationFixture(async ({ root, env, service }) => {
      vi.mocked(service.readRuntime).mockResolvedValue({
        status: "running",
        pid: 23456,
        systemd: { managerUid: 2001 },
      });
      const entry = path.join(root, "dist", "entry.js");
      const before = await fs.readFile(entry, "utf8");
      const spawn = vi.fn(() => {
        throw new Error("Automatic build started under the serving Gateway");
      });
      const attempt = runNodeMain({
        cwd: root,
        args: [...(profile ? ["--profile", profile] : []), "doctor"],
        env: { ...env, OPENCLAW_RUNNER_LOG: "0" },
        spawn,
      });
      await expect(attempt).rejects.toThrow(/affected Gateway.*running/);
      await expect(attempt).rejects.toThrow(
        `openclaw${profile ? ` --profile ${profile}` : ""} gateway stop`,
      );
      await expect(attempt).rejects.toThrow("retry the original command");
      expect(spawn).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(service.readRuntime)
          .mock.calls.some(([observedEnv]) => observedEnv?.OPENCLAW_PROFILE === profile),
      ).toBe(true);
      expect(await fs.readFile(entry, "utf8")).toBe(before);
    }),
);

it("holds Gateway startup custody until the automatic source build exits", () =>
  withRuntimePublicationFixture(async ({ root, env, databasePath }) => {
    let builds = 0;
    const spawn = (_command: string, args: string[]) => {
      if (args.some((arg) => arg.endsWith("scripts/build-all.mts"))) {
        builds += 1;
        const competingStartup = tryAcquireGatewayStateOwner(databasePath);
        competingStartup?.release();
        expect(competingStartup).toBeNull();
      }
      return {
        on(event: string, listener: (code: number, signal: null) => void) {
          if (event === "exit") {
            queueMicrotask(() => listener(0, null));
          }
        },
      };
    };
    expect(
      await runNodeMain({
        cwd: root,
        args: ["doctor"],
        env: { ...env, OPENCLAW_RUNNER_LOG: "0" },
        spawn,
      }),
    ).toBe(0);
    expect(builds).toBe(1);
  }));

it.each([
  { changed: true, sourceRuntimePrepared: undefined },
  { changed: false, sourceRuntimePrepared: undefined },
  { changed: true, sourceRuntimePrepared: false },
  { changed: true, sourceRuntimePrepared: true },
])(
  "parks before changed runtime publication (changed=$changed, prepared=$sourceRuntimePrepared)",
  ({ changed, sourceRuntimePrepared }) =>
    withRuntimePublicationFixture(async ({ root, env, service }) => {
      vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("git");
      const scripts = path.join(root, "scripts");
      const artifact = path.join(root, "dist-runtime", "published.txt");
      await fs.mkdir(path.join(scripts, "lib"), { recursive: true });
      await fs.writeFile(
        path.join(scripts, "stage-bundled-plugin-runtime.mts"),
        `import fs from "node:fs/promises";
export function prepareBundledPluginRuntime() {
  if (${sourceRuntimePrepared === true}) throw new Error("Prepared runtime must not be staged again");
  return {
    changed: ${changed},
    async publish(assertCurrent) {
      await assertCurrent();
      await fs.writeFile(${JSON.stringify(artifact)}, "candidate");
    },
    async cleanup() {},
  };
}
`,
      );
      await fs.writeFile(
        path.join(scripts, "lib", "dist-artifact-ownership.mts"),
        sourceRuntimePrepared === false
          ? "throw new Error('The admitted runtime must not load the legacy lock owner');\n"
          : "export async function withDistArtifactOwnership(_root, run) { return await run(); }\n",
      );
      await fs.writeFile(artifact, "original");
      const lock = vi.mocked(gatewayLocks.readActiveGatewayLockIdentity);
      lock.mockResolvedValue({ pid: process.pid, createdAt: "now", port: 18789 });
      const park = vi.fn(async () => {
        expect(service.readRuntime).not.toHaveBeenCalled();
        expect(lock).not.toHaveBeenCalled();
        expect(await fs.readFile(artifact, "utf8")).toBe("original");
        lock.mockResolvedValue(undefined);
      });
      const readExpiry = () => {
        const value = openOpenClawStateDatabase({ env })
          .db.prepare(
            "SELECT expires_at FROM state_leases WHERE scope = 'core:plugin-lifecycle' AND lease_key = 'global'",
          )
          .get()?.expires_at;
        if (typeof value !== "number") {
          throw new Error("Expected a persisted plugin lifecycle lease expiry");
        }
        return value;
      };
      const leaseMs = 1_000;
      vi.useFakeTimers({
        toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
      try {
        await expect(
          withPluginLifecycleLease({ env, waitMs: 0, leaseMs }, async (lease) => {
            // The worker acquires against its real clock; align the controlled timer clock afterward.
            vi.setSystemTime(readExpiry() - leaseMs);
            const result = await completeSourceUpdateRuntime({
              root,
              sourceRuntimePrepared,
              timeoutMs: 1_000,
              lease,
              beforePublication: park,
              beforePersistentEffect: async () => {
                const maintenance = getOpenClawDatabaseMaintenanceScope();
                expect(maintenance).toBeDefined();
                maintenance?.assertDatabaseAccess(lease.databasePath);
                runOutsideOpenClawDatabaseMaintenanceScope(() => {
                  expect(() => openOpenClawStateDatabase({ env })).toThrow("offline maintenance");
                });
                const before = readExpiry();
                await vi.advanceTimersByTimeAsync(leaseMs * 4);
                lease.assertOwned();
                expect(readExpiry()).toBeGreaterThan(before + leaseMs * 3);
                expect(lease.signal.aborted).toBe(false);
              },
            });
            expect(getOpenClawDatabaseMaintenanceScope()).toBeUndefined();
            const afterPublication = readExpiry();
            await vi.advanceTimersByTimeAsync(leaseMs * 4);
            lease.assertOwned();
            expect(readExpiry()).toBeGreaterThan(afterPublication + leaseMs * 3);
            return result;
          }),
        ).resolves.toEqual({ changed: changed && sourceRuntimePrepared !== true });
        const published = changed && sourceRuntimePrepared !== true;
        expect(park).toHaveBeenCalledTimes(published ? 1 : 0);
        expect(await fs.readFile(artifact, "utf8")).toBe(published ? "candidate" : "original");
        if (published) {
          expect(lock).toHaveBeenCalled();
        } else {
          expect(service.readRuntime).not.toHaveBeenCalled();
          expect(lock).not.toHaveBeenCalled();
        }
      } finally {
        vi.useRealTimers();
        closeOpenClawStateDatabaseForTest();
      }
    }),
);

it.each([
  "unknown runtime",
  "unknown command",
  "unknown load state",
  "respawn disabled",
  "unknown lock",
  "explicit listener",
  "unknown listener",
  "lock after coordinator",
])("refuses changed runtime publication with %s", (scenario) =>
  withRuntimePublicationFixture(async ({ root, env, service }) => {
    if (scenario === "unknown runtime") {
      vi.mocked(service.readRuntime).mockResolvedValue({
        status: "unknown",
        systemd: { managerUid: 2001 },
      });
    } else if (scenario === "unknown command") {
      vi.mocked(service.readCommand).mockResolvedValue(null);
    } else if (scenario === "unknown load state") {
      vi.mocked(service.isLoaded).mockRejectedValue(new Error("inspection failed"));
    } else if (scenario === "respawn disabled") {
      mockProcessPlatform("darwin");
    } else if (scenario === "lock after coordinator") {
      vi.mocked(gatewayLocks.readActiveGatewayLockIdentity)
        .mockResolvedValue({ pid: process.pid, createdAt: "now", port: 18789 })
        .mockResolvedValueOnce(undefined);
    } else if (scenario === "unknown lock") {
      vi.mocked(gatewayLocks.readActiveGatewayLockIdentity).mockRejectedValue(new Error("unknown"));
    } else if (scenario === "explicit listener") {
      vi.mocked(service.readCommand).mockResolvedValue({
        programArguments: [
          process.execPath,
          path.join(root, "dist", "entry.js"),
          "gateway",
          "--port",
          "19420",
        ],
      });
      vi.mocked(portProbe.probePortUsage).mockImplementation(async (port) =>
        port === 19420 ? "busy" : "free",
      );
    } else if (scenario === "unknown listener") {
      vi.mocked(portProbe.probePortUsage).mockResolvedValue("unknown");
    }
    const publish = vi.fn(async () => "published");
    await expect(
      withGatewayRuntimeArtifactPublication(
        { root, env, timeoutMs: 200, assertCurrent() {} },
        publish,
      ),
    ).rejects.toThrow(
      /affected Gateway.*openclaw gateway status --deep.*openclaw gateway stop.*retry the original command/,
    );
    expect(publish).not.toHaveBeenCalled();
  }),
);

it("refuses changed runtime publication while another process owns Gateway presence", () =>
  withRuntimePublicationFixture(async ({ root, env, databasePath }) => {
    const other = tryAcquireGatewayStateOwner(databasePath);
    expect(other).not.toBeNull();
    const publish = vi.fn(async () => "published");
    try {
      await expect(
        withGatewayRuntimeArtifactPublication(
          { root, env, timeoutMs: 200, assertCurrent() {} },
          publish,
        ),
      ).rejects.toThrow(/affected Gateway/);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      other?.release();
    }
  }));

it("publishes changed artifacts for an affirmatively absent Gateway", () =>
  withRuntimePublicationFixture(async ({ root, env, service, databasePath }) => {
    service.isAbsent = vi.fn(async () => true);
    await expect(
      withGatewayRuntimeArtifactPublication(
        { root, env, timeoutMs: 200, assertCurrent() {} },
        async (assertCurrent) => {
          await Promise.resolve();
          await assertCurrent();
          expect(tryAcquireGatewayStateOwner(databasePath)).toBeNull();
          return "published";
        },
      ),
    ).resolves.toBe("published");
  }));

it.each([
  "disjoint",
  "shared overlay",
  "shared SDK alias",
  "shared SDK parent",
  "nested shared output",
])("distinguishes physical runtime paths from current/releases ownership: %s", (scenario) =>
  withRuntimePublicationFixture(async ({ home, root, env, service, databasePath }) => {
    const snapshot = path.join(home, "releases", "previous");
    await fs.mkdir(path.join(snapshot, "dist"), { recursive: true });
    await fs.writeFile(path.join(snapshot, "package.json"), JSON.stringify({ name: "openclaw" }));
    await fs.writeFile(path.join(snapshot, "dist", "entry.js"), "export {};\n");
    const current = path.join(home, "current");
    await fs.symlink(snapshot, current, "junction");
    if (scenario === "shared overlay") {
      await fs.symlink(
        path.join(root, "dist-runtime"),
        path.join(snapshot, "dist-runtime"),
        "junction",
      );
    } else if (scenario === "shared SDK alias") {
      const aliasParent = path.join(snapshot, "dist", "extensions", "node_modules");
      await fs.mkdir(aliasParent, { recursive: true });
      await fs.symlink(root, path.join(aliasParent, "openclaw"), "junction");
    } else if (scenario === "shared SDK parent") {
      const aliasParent = path.join(root, "dist", "extensions", "node_modules");
      await fs.mkdir(aliasParent, { recursive: true });
      await fs.mkdir(path.join(snapshot, "dist", "extensions"));
      await fs.symlink(
        aliasParent,
        path.join(snapshot, "dist", "extensions", "node_modules"),
        "junction",
      );
    } else if (scenario === "nested shared output") {
      const nested = path.join(root, "dist-runtime", "extensions", "demo");
      const aliasParent = path.join(snapshot, "dist", "extensions", "node_modules");
      await fs.mkdir(nested, { recursive: true });
      await fs.mkdir(aliasParent, { recursive: true });
      await fs.symlink(nested, path.join(aliasParent, "openclaw"), "junction");
    }
    vi.mocked(service.readCommand).mockResolvedValue({
      programArguments: [process.execPath, path.join(current, "dist", "entry.js"), "gateway"],
      managedDefinition: {
        programArguments: [process.execPath, path.join(root, "dist", "entry.js"), "gateway"],
      },
    });
    vi.mocked(service.readRuntime).mockResolvedValue({
      status: "running",
      systemd: { managerUid: 2001 },
    });
    vi.mocked(portProbe.probePortUsage).mockResolvedValue("busy");
    const other = tryAcquireGatewayStateOwner(databasePath);
    expect(other).not.toBeNull();
    const publish = vi.fn(async (assertCurrent: () => Promise<void>) => {
      await assertCurrent();
      return "published";
    });
    try {
      const result = withGatewayRuntimeArtifactPublication(
        { root, env, timeoutMs: 200, assertCurrent() {} },
        publish,
      );
      if (scenario === "disjoint") {
        await expect(result).resolves.toBe("published");
      } else {
        await expect(result).rejects.toThrow(/affected Gateway/);
        expect(publish).not.toHaveBeenCalled();
      }
    } finally {
      other?.release();
    }
  }),
);

it.each([
  { label: "already live", late: false, output: "dist-runtime", shared: "dist-runtime" },
  {
    label: "discovered before the effect",
    late: true,
    output: "dist-runtime",
    shared: "dist-runtime",
  },
  { label: "physically disjoint", late: false, output: "dist-runtime", shared: undefined },
  {
    label: "custom output shared",
    late: false,
    output: "custom-runtime",
    shared: "custom-runtime",
  },
  {
    label: "custom output disjoint",
    late: false,
    output: "custom-runtime",
    shared: "dist-runtime",
  },
])("fences runtime-only publication against a sibling that is $label", ({ late, output, shared }) =>
  withRuntimePublicationFixture(async ({ home, root, env, service }) => {
    const sibling = path.join(home, "sibling");
    await fs.mkdir(path.join(sibling, "dist"), { recursive: true });
    await fs.writeFile(path.join(sibling, "package.json"), JSON.stringify({ name: "openclaw" }));
    await fs.writeFile(path.join(sibling, "dist", "entry.js"), "export {};\n");
    await fs.mkdir(path.join(root, output), { recursive: true });
    if (shared) {
      await fs.symlink(path.join(root, shared), path.join(sibling, shared), "junction");
    }
    const directory = path.join(home, ".config", "systemd", "user");
    await fs.mkdir(directory, { recursive: true });
    const scan = serviceFiles.scanSystemdDir;
    vi.spyOn(serviceFiles, "scanSystemdDir").mockImplementation((params) =>
      params.dir === directory ? scan(params) : Promise.resolve([]),
    );
    const unit = "openclaw-gateway-sibling.service";
    const discoverSibling = () =>
      fs.writeFile(
        path.join(directory, unit),
        `[Service]\nEnvironment="OPENCLAW_PROFILE=sibling" "OPENCLAW_SERVICE_MARKER=openclaw" "OPENCLAW_SERVICE_KIND=gateway"\nExecStart=${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(sibling, "dist", "entry.js"))} gateway\n`,
      );
    if (!late) {
      await discoverSibling();
    }
    vi.mocked(service.readCommand).mockImplementation(async (serviceEnv) => ({
      programArguments: [
        process.execPath,
        path.join(serviceEnv?.OPENCLAW_SYSTEMD_UNIT === unit ? sibling : root, "dist", "entry.js"),
        "gateway",
      ],
    }));
    vi.mocked(service.readRuntime).mockImplementation(async (serviceEnv) => ({
      status: serviceEnv?.OPENCLAW_SYSTEMD_UNIT === unit ? "running" : "stopped",
      systemd: { managerUid: 2001 },
    }));
    const artifact = path.join(root, output, "published.txt");
    await fs.writeFile(artifact, "original");
    const publication = withGatewayRuntimeArtifactPublication(
      { root, env, timeoutMs: 200, assertCurrent() {}, outputPaths: [output] },
      async (assertPublicationCurrent) => {
        if (late) {
          await discoverSibling();
        }
        await assertPublicationCurrent();
        await fs.writeFile(artifact, "candidate");
      },
    );
    const overlaps = shared === output;
    if (overlaps) {
      await expect(publication).rejects.toMatchObject({ reason: "runtime-artifact-publication" });
    } else {
      await expect(publication).resolves.toBeUndefined();
    }
    expect(await fs.readFile(artifact, "utf8")).toBe(overlaps ? "original" : "candidate");
  }),
);

it.each(["inspection", "publication"])(
  "retains the caller's publication lease across %s awaits",
  (when) =>
    withRuntimePublicationFixture(async ({ root, env, service }) => {
      let current = true;
      if (when === "inspection") {
        vi.mocked(service.readRuntime).mockImplementation(async () => {
          await Promise.resolve();
          current = false;
          return { status: "stopped", systemd: { managerUid: 2001 } };
        });
      }
      const mutate = vi.fn();
      await expect(
        withGatewayRuntimeArtifactPublication(
          {
            root,
            env,
            timeoutMs: 200,
            assertCurrent() {
              if (!current) {
                throw new Error("publication lease lost");
              }
            },
          },
          async (assertCurrent) => {
            await Promise.resolve();
            current = false;
            await assertCurrent();
            mutate();
          },
        ),
      ).rejects.toThrow("publication lease lost");
      expect(mutate).not.toHaveBeenCalled();
    }),
);

it.each([
  "running",
  "changed launcher",
  "replaced entrypoint",
  "changed manager",
  "changed state directory",
  "disjoint becomes affected",
  "disjoint becomes unknown",
])("rechecks publication authority after an awaited boundary: %s", (change) =>
  withRuntimePublicationFixture(async ({ home, root, env, service }) => {
    if (change.startsWith("disjoint")) {
      const snapshot = path.join(root, ".artifacts", "serving");
      await fs.mkdir(path.join(snapshot, "dist"), { recursive: true });
      await fs.writeFile(path.join(snapshot, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(path.join(snapshot, "dist", "entry.js"), "export {};\n");
      vi.mocked(service.readCommand).mockResolvedValue({
        programArguments: [process.execPath, path.join(snapshot, "dist", "entry.js"), "gateway"],
      });
    }
    const untouched = path.join(root, "dist-runtime", "unchanged.txt");
    await fs.writeFile(untouched, "original");
    const beforePersistentEffect = async () => {
      await Promise.resolve();
      if (change === "running") {
        vi.mocked(service.readRuntime).mockResolvedValue({
          status: "running",
          systemd: { managerUid: 2001 },
        });
      } else if (change === "changed manager") {
        vi.mocked(service.readRuntime).mockResolvedValue({
          status: "stopped",
          systemd: { managerUid: 3002 },
        });
      } else if (change === "changed state directory") {
        env.OPENCLAW_STATE_DIR = path.join(home, "replacement-state");
      } else if (change === "replaced entrypoint") {
        const entry = path.join(root, "dist", "entry.js");
        await fs.rename(entry, `${entry}.previous`);
        await fs.writeFile(entry, "export const replaced = true;\n");
      } else if (change === "disjoint becomes unknown") {
        vi.mocked(service.readCommand).mockResolvedValue(null);
      } else {
        vi.mocked(service.readCommand).mockResolvedValue({
          programArguments: [
            process.execPath,
            path.join(root, "dist", "entry.js"),
            "gateway",
            ...(change === "changed launcher" ? ["--verbose"] : []),
          ],
        });
      }
    };
    await expect(
      withGatewayRuntimeArtifactPublication(
        { root, env, timeoutMs: 200, assertCurrent() {} },
        async (assertPublicationCurrent) => {
          await beforePersistentEffect();
          await assertPublicationCurrent();
          await fs.writeFile(untouched, "published");
        },
      ),
    ).rejects.toThrow(/affected Gateway/);
    expect(await fs.readFile(untouched, "utf8")).toBe("original");
  }),
);

it.each(["repository", "existing alias parent", "missing alias parent"])(
  "rejects an awaited physical target redirection with no native service: %s",
  (change) =>
    withRuntimePublicationFixture(async ({ home, root, env, service }) => {
      service.isAbsent = vi.fn(async () => true);
      const parent = path.join(root, "dist", "extensions", "node_modules");
      const replacement = path.join(home, "replacement");
      await fs.mkdir(replacement);
      if (change === "existing alias parent") {
        await fs.mkdir(parent, { recursive: true });
      }
      await expect(
        withGatewayRuntimeArtifactPublication(
          { root, env, timeoutMs: 200, assertCurrent() {} },
          async (assertPublicationCurrent) => {
            await Promise.resolve();
            if (change === "repository") {
              await fs.rename(root, `${root}-before`);
              await fs.symlink(replacement, root, "junction");
            } else {
              if (change === "existing alias parent") {
                await fs.rename(parent, `${parent}-before`);
              } else {
                await fs.mkdir(path.dirname(parent), { recursive: true });
              }
              await fs.symlink(replacement, parent, "junction");
            }
            await assertPublicationCurrent();
            await fs.writeFile(path.join(replacement, "published.txt"), "changed");
          },
        ),
      ).rejects.toThrow(/affected Gateway/);
      expect(await fs.readdir(replacement)).toEqual([]);
    }),
);

it("permits its output-root replacement and new alias descendants while retaining parent identity", () =>
  withRuntimePublicationFixture(async ({ root, env }) => {
    const runtime = path.join(root, "dist-runtime");
    const previous = path.join(root, "previous-runtime");
    const alias = path.join(root, "dist", "extensions", "node_modules", "openclaw");
    await withGatewayRuntimeArtifactPublication(
      { root, env, timeoutMs: 200, assertCurrent() {} },
      async (assertCurrent) => {
        await assertCurrent();
        await fs.rename(runtime, previous);
        await assertCurrent();
        await fs.mkdir(runtime);
        await assertCurrent();
        await fs.mkdir(alias, { recursive: true });
        await assertCurrent();
        await fs.writeFile(path.join(runtime, "published.txt"), "new runtime");
      },
    );
    expect(await fs.readFile(path.join(runtime, "published.txt"), "utf8")).toBe("new runtime");
    expect((await fs.stat(alias)).isDirectory()).toBe(true);
  }));

it("holds native and Gateway exclusion through publication rollback and closes its assertion", () =>
  withRuntimePublicationFixture(async ({ root, env, databasePath }) => {
    let retainedAssertion: (() => Promise<void>) | undefined;
    let rolledBack = false;
    await expect(
      withGatewayRuntimeArtifactPublication(
        { root, env, timeoutMs: 200, assertCurrent() {} },
        async (assertCurrent) => {
          retainedAssertion = assertCurrent;
          try {
            await assertCurrent();
            expect(tryAcquireGatewayStateOwner(databasePath)).toBeNull();
            throw new Error("publication failed");
          } finally {
            await withGatewayServiceOperationLock(env, async (assertNative) => {
              await Promise.resolve();
              await assertCurrent();
              assertNative();
              expect(tryAcquireGatewayStateOwner(databasePath)).toBeNull();
              rolledBack = true;
            });
          }
        },
      ),
    ).rejects.toThrow("publication failed");
    expect(rolledBack).toBe(true);
    await expect(retainedAssertion!()).rejects.toThrow(/ownership has closed/);
    const released = tryAcquireGatewayStateOwner(databasePath);
    expect(released).not.toBeNull();
    released?.release();
  }));

it.each([false, true])(
  "settles cleanup writes and releases publication custody after disposal fails (publication failed: %s)",
  (publicationFailed) =>
    withRuntimePublicationFixture(async ({ root, env, databasePath }) => {
      openOpenClawStateDatabase({ env });
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const publicationFailure = new Error("publication failed before cleanup");
      const cleanupFailure = new Error("publication resource disposal failed");
      let accepted: Promise<void> | undefined;
      let settled = false;
      let observedError: unknown;
      const publication = withGatewayRuntimeArtifactPublication(
        { root, env, timeoutMs: 200, assertCurrent() {} },
        async () => {
          const maintenance = getOpenClawDatabaseMaintenanceScope();
          if (!maintenance) {
            throw new Error("Expected publication maintenance authority");
          }
          maintenance.own({}, "shared-resources", () => {
            accepted = maintenance.run(async () => {
              entered.resolve();
              await resume.promise;
              openOpenClawStateDatabase({ env })
                .db.prepare(
                  "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('publication-cleanup-proof', 'true', 1)",
                )
                .run();
            });
            throw cleanupFailure;
          });
          if (publicationFailed) {
            throw publicationFailure;
          }
          return "published";
        },
      ).then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          observedError = error;
        },
      );
      try {
        await entered.promise;
        // Let the rejected disposal batch settle while its accepted write is still blocked.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        expect(tryAcquireGatewayStateOwner(databasePath)).toBeNull();
        resume.resolve();
        await publication;
        await accepted;
        expect(observedError).toEqual(
          publicationFailed
            ? expect.objectContaining({
                cause: publicationFailure,
                errors: [publicationFailure, cleanupFailure],
              })
            : cleanupFailure,
        );
        const next = tryAcquireGatewayStateOwner(databasePath);
        expect(next).not.toBeNull();
        next?.release();
        expect(
          openOpenClawStateDatabase({ env })
            .db.prepare(
              "SELECT value_json FROM config_machine_state WHERE state_key = 'publication-cleanup-proof'",
            )
            .get(),
        ).toEqual({ value_json: "true" });
      } finally {
        resume.resolve();
        await publication;
        closeOpenClawStateDatabaseForTest();
      }
    }),
);
