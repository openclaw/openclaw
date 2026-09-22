import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as gatewayLocks from "../../infra/gateway-lock.js";
import * as portProbe from "../../infra/ports-probe.js";
import { tryAcquireExclusiveSqliteCoordinator } from "../../infra/sqlite-coordinator.js";
import { acquireGatewayLifecycleCoordinator } from "../../infra/state-database-coordinator.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { withGatewayRuntimeArtifactPublication } from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({ service: vi.fn<() => GatewayService>() }));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => mockSystemAccountHome());
afterEach(() => vi.restoreAllMocks());

async function withServiceHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = tempDirs.make("openclaw-runtime-publication-");
  vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
  await withEnvAsync(
    {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData"),
      OPENCLAW_GATEWAY_PORT: undefined,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
    },
    () => run(home),
  );
}

async function withRuntimePublicationFixture(
  run: (fixture: {
    home: string;
    root: string;
    env: NodeJS.ProcessEnv;
    service: GatewayService;
    coordinatorPath: string;
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
    const coordinator = acquireGatewayLifecycleCoordinator({
      databasePath: resolveOpenClawStateSqlitePath(env),
      busyTimeoutMs: 0,
    });
    coordinator.release();
    await run({ home, root, env, service, coordinatorPath: coordinator.path });
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  });
}

it.each([
  "running",
  "unknown runtime",
  "unknown command",
  "unknown load state",
  "respawn enabled",
  "active lock",
  "unknown lock",
  "busy listener",
  "explicit listener",
  "unknown listener",
  "running after coordinator",
  "lock after coordinator",
])("refuses changed runtime publication with %s", (scenario) =>
  withRuntimePublicationFixture(async ({ root, env, service }) => {
    if (scenario === "running" || scenario === "unknown runtime") {
      vi.mocked(service.readRuntime).mockResolvedValue({
        status: scenario === "running" ? "running" : "unknown",
        systemd: { managerUid: 2001 },
      });
    } else if (scenario === "unknown command") {
      vi.mocked(service.readCommand).mockResolvedValue(null);
    } else if (scenario === "unknown load state") {
      vi.mocked(service.isLoaded).mockRejectedValue(new Error("inspection failed"));
    } else if (scenario === "respawn enabled") {
      mockProcessPlatform("darwin");
      vi.mocked(service.isEnabled!).mockResolvedValue(true);
    } else if (scenario === "active lock" || scenario === "lock after coordinator") {
      const lock = vi.mocked(gatewayLocks.readActiveGatewayLockIdentity);
      lock.mockResolvedValue({ pid: process.pid, createdAt: "now", port: 18789 });
      if (scenario === "lock after coordinator") {
        lock.mockResolvedValueOnce(undefined);
      }
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
    } else if (scenario === "busy listener" || scenario === "unknown listener") {
      vi.mocked(portProbe.probePortUsage).mockResolvedValue(
        scenario === "busy listener" ? "busy" : "unknown",
      );
    } else {
      vi.mocked(service.readRuntime)
        .mockResolvedValueOnce({ status: "stopped", systemd: { managerUid: 2001 } })
        .mockResolvedValue({ status: "running", systemd: { managerUid: 2001 } });
    }
    const publish = vi.fn(async () => "published");
    await expect(
      withGatewayRuntimeArtifactPublication(
        { root, env, timeoutMs: 200, assertCurrent() {} },
        publish,
      ),
    ).rejects.toThrow(/affected Gateway.*retry the update/);
    expect(publish).not.toHaveBeenCalled();
  }),
);

it("refuses changed runtime publication while another process owns Gateway presence", () =>
  withRuntimePublicationFixture(async ({ root, env, coordinatorPath }) => {
    const other = tryAcquireExclusiveSqliteCoordinator(coordinatorPath);
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

it.each(["stopped", "absent"])(
  "publishes changed artifacts for an affirmatively %s Gateway",
  (state) =>
    withRuntimePublicationFixture(async ({ root, env, service, coordinatorPath }) => {
      if (state === "absent") {
        service.isAbsent = vi.fn(async () => true);
      }
      await expect(
        withGatewayRuntimeArtifactPublication(
          { root, env, timeoutMs: 200, assertCurrent() {} },
          async (assertCurrent) => {
            await Promise.resolve();
            await assertCurrent();
            expect(tryAcquireExclusiveSqliteCoordinator(coordinatorPath)).toBeNull();
            return "published";
          },
        ),
      ).resolves.toBe("published");
    }),
);

it.each([
  "disjoint",
  "shared overlay",
  "shared SDK alias",
  "shared SDK parent",
  "nested shared output",
])("distinguishes physical runtime paths from current/releases ownership: %s", (scenario) =>
  withRuntimePublicationFixture(async ({ home, root, env, service, coordinatorPath }) => {
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
    const other = tryAcquireExclusiveSqliteCoordinator(coordinatorPath);
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
  "unknown runtime",
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
      if (change === "running" || change === "unknown runtime") {
        vi.mocked(service.readRuntime).mockResolvedValue({
          status: change === "running" ? "running" : "unknown",
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
  withRuntimePublicationFixture(async ({ root, env, coordinatorPath }) => {
    let retainedAssertion: (() => Promise<void>) | undefined;
    let rolledBack = false;
    await expect(
      withGatewayRuntimeArtifactPublication(
        { root, env, timeoutMs: 200, assertCurrent() {} },
        async (assertCurrent) => {
          retainedAssertion = assertCurrent;
          try {
            await assertCurrent();
            expect(tryAcquireExclusiveSqliteCoordinator(coordinatorPath)).toBeNull();
            throw new Error("publication failed");
          } finally {
            await withGatewayServiceOperationLock(env, async (assertNative) => {
              await Promise.resolve();
              await assertCurrent();
              assertNative();
              expect(tryAcquireExclusiveSqliteCoordinator(coordinatorPath)).toBeNull();
              rolledBack = true;
            });
          }
        },
      ),
    ).rejects.toThrow("publication failed");
    expect(rolledBack).toBe(true);
    await expect(retainedAssertion!()).rejects.toThrow(/ownership has closed/);
    const released = tryAcquireExclusiveSqliteCoordinator(coordinatorPath);
    expect(released).not.toBeNull();
    released?.release();
  }));
