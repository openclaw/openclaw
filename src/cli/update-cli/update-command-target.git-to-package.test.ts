import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayServiceState } from "../../daemon/service.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { GIT_RELEASE_LAUNCHER, gitReleaseForwardingEntry } from "../../infra/git-release-paths.js";
import { pkgQueryResult } from "../../infra/update-freebsd-pkg-ownership.test-support.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { inspectUpdateManagedServices } from "./update-command-database-context.js";
import { reserveUpdateCommandExecutorSlot } from "./update-command-executor-capabilities.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { useExecutorFixture } from "./update-command-executor.test-support.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-revalidation.js";

const npm = vi.hoisted(() => ({ globalRoot: "" }));
const readService = vi.hoisted(() => vi.fn<() => Promise<GatewayServiceState>>());
vi.mock("../../daemon/service.js", async (original) => ({
  ...(await original<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: readService,
}));
vi.mock("../../infra/update-global.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-global.js")>()),
  createGlobalInstallEnv: async () => ({}),
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runCommandBuffered: async () => pkgQueryResult(),
  runCommandWithTimeout: async (argv: string[]) => {
    if (argv.includes("--version")) {
      return { code: 0, stdout: "12.0.0", stderr: "" };
    }
    if (argv[1] === "root" && argv[2] === "-g") {
      return { code: 0, stdout: npm.globalRoot, stderr: "" };
    }
    throw new Error(`Unexpected command in read-only resolver: ${argv.join(" ")}`);
  },
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  DEFAULT_PACKAGE_NAME: "openclaw",
  normalizeTag: () => null,
  readPackageName: async () => "openclaw",
  readPackageVersion: async () => "2026.11.6",
  resolveGlobalManager: async () => "npm",
}));
vi.mock("./update-command-config.js", async (original) => ({
  ...(await original<typeof import("./update-command-config.js")>()),
  readUpdateChannelConfig: async () => ({ configSnapshot: { valid: true }, storedChannel: "dev" }),
}));
vi.mock("./update-command-target-space.js", async (original) => ({
  ...(await original<typeof import("./update-command-target-space.js")>()),
  checkUpdateTargetSnapshotSpace: async () => undefined,
}));
vi.mock("../../infra/disk-space.js", async (original) => ({
  ...(await original<typeof import("../../infra/disk-space.js")>()),
  describePackageStagingShortfall: () => null,
}));
vi.mock("../../infra/update-check.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-check.js")>()),
  resolveNpmChannelTag: async () => ({ tag: "latest", version: "2026.11.31" }),
}));
vi.mock("../../infra/update-check-package-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check-package-target.js")>()),
  fetchNpmPackageTargetStatus: async () => ({ version: "2026.11.31" }),
}));
import { resolveUpdateCommandTarget } from "./update-command-target.js";

const fixture = useExecutorFixture("update-git-to-package-");
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "home" });
  mockSystemAccountHome();
  readService.mockReset().mockResolvedValue({
    env: state.env,
    installed: false,
    running: false,
    command: null,
    loadState: { status: "not-loaded" },
  });
});
afterEach(async () => {
  await state.cleanup();
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")("a switch from a Git release to npm", () => {
  // Keyed by the Git install, the reservation refused with "Occupied slot does not resolve to
  // its original installation." (forwarding package, #200578) or `ENOENT: realpath` (no copy).
  it.each([
    { layout: "forwarding package", managed: false },
    { layout: "no npm copy", managed: false },
    { layout: "no npm copy, managed Git launcher", managed: true },
  ])("lets the package swap reserve its destination ($layout)", async ({ layout, managed }) => {
    const { root } = fixture();
    const prefix = state.statePath("git-install");
    const release = path.join(prefix, "releases", "r1", "openclaw");
    fs.mkdirSync(path.join(release, "dist"), { recursive: true });
    fs.writeFileSync(path.join(release, "dist", "index.js"), "export {};\n");
    fs.writeFileSync(
      path.join(release, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.11.6" }),
    );
    const gitSlot = path.join(prefix, "openclaw");
    fs.symlinkSync(path.join("releases", "r1", "openclaw"), gitSlot);
    npm.globalRoot = path.join(root, "npm", "lib", "node_modules");
    fs.mkdirSync(npm.globalRoot, { recursive: true });
    const bin = path.join(npm.globalRoot, "..", "..", "bin");
    fs.mkdirSync(bin, { recursive: true });
    const packageRoot = path.join(npm.globalRoot, "openclaw");
    if (managed) {
      readService.mockResolvedValue({
        env: state.env,
        installed: true,
        running: false,
        command: {
          programArguments: [process.execPath, path.join(prefix, GIT_RELEASE_LAUNCHER), "gateway"],
        },
        loadState: { status: "loaded" },
        runtime: { status: "stopped", systemd: { managerUid: process.getuid?.() ?? 1000 } },
        definitionMutationCapability: { kind: "writable" },
      });
    }
    if (layout === "forwarding package") {
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, "openclaw.mjs"),
        gitReleaseForwardingEntry(path.join(prefix, GIT_RELEASE_LAUNCHER)),
      );
      fs.symlinkSync(
        path.relative(bin, path.join(packageRoot, "openclaw.mjs")),
        path.join(bin, "openclaw"),
      );
    }
    const run = {
      runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
      env: state.env,
    } as NonNullable<Parameters<typeof resolveUpdateCommandTarget>[0]["run"]>;
    const prepared = {
      discoveredRoot: gitSlot,
      installKind: "git",
      requestedChannel: "stable",
      timeoutMs: 1000,
      shouldRestart: managed,
      servicePlan: managed ? undefined : { rootRedirect: null },
    } as Parameters<typeof resolveUpdateCommandTarget>[3];

    await withUpdateCommandExecutor(run.runId, async (executor) => {
      const target = await withMockedPlatform("linux", () =>
        resolveUpdateCommandTarget(
          { json: true, yes: true, channel: "stable", run },
          { triageTarget: { root: gitSlot } } as Parameters<typeof resolveUpdateCommandTarget>[1],
          undefined,
          prepared,
          executor,
          1000,
        ),
      );
      expect(target?.packageInstallTarget?.packageRoot).toBe(packageRoot);
      // The staged package swap reserves its destination before publishing.
      reserveUpdateCommandExecutorSlot(run.executorFence!, packageRoot);
      if (managed) {
        expect(target?.managedServiceRoot).toBe(gitSlot);
        const admission = await withMockedPlatform("linux", () =>
          inspectUpdateManagedServices({
            roots: [packageRoot],
            managedServiceRoot: target?.managedServiceRoot,
            managedServiceRootRedirect: null,
            updateInstallKind: "package",
            shouldRestart: true,
            jsonMode: true,
            timeoutMs: 1000,
          }),
        );
        expect(admission.service?.serviceUpdateVerdict).toMatchObject({
          kind: "owned",
          root: gitSlot,
          refreshDefinition: true,
        });
        // The launcher still resolves to Git after npm publishes a plain package.
        fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
        fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "export {};\n");
        fs.writeFileSync(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2026.11.31" }),
        );
        const serviceState = await readService();
        await expect(
          revalidateManagedGatewayServiceAfterUpdate({
            state: serviceState,
            root: packageRoot,
            preManagedServiceStop: admission.service,
            allowInstallRootChange: true,
          }),
        ).resolves.toMatchObject({
          kind: "owned",
          root: gitSlot,
          requiresInstallRootRefresh: true,
        });
      }
    });
  });
});
