import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  copyPackageDirInstallTransactionRequest,
  installPackageDir,
} from "../infra/install-package-dir.js";
import {
  requestDeferredPluginInstall,
  settlePluginInstallTransactions,
  type PluginInstallTransaction,
} from "../plugins/install-transaction.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import type { installHooksFromNpmSpec } from "./install.js";
import { readHookInstalls, recordHookInstall } from "./installs.js";

const installNpm = vi.fn();

vi.mock("./install.js", () => ({
  installHooksFromNpmSpec: (...args: unknown[]) => installNpm(...args),
  resolveHookInstallDir: (hookId: string) => `/tmp/hooks/${hookId}`,
}));

const { updateNpmInstalledHookPacks } = await import("./update.js");

async function update(
  params: Parameters<typeof updateNpmInstalledHookPacks>[0],
  action: "commit" | "rollback" = "commit",
) {
  if (params.dryRun) {
    return await updateNpmInstalledHookPacks(params);
  }
  return await withPluginLifecycleLease({}, async (lease) => {
    const transactions: PluginInstallTransaction[] = [];
    try {
      const result = await updateNpmInstalledHookPacks(
        requestDeferredPluginInstall({ ...params, lease }, transactions),
      );
      await settlePluginInstallTransactions(transactions, action);
      return result;
    } catch (error) {
      await settlePluginInstallTransactions(transactions, "rollback");
      throw error;
    }
  });
}

function configFor(
  params: {
    spec?: string;
    integrity?: string;
    installPath?: string;
  } = {},
): OpenClawConfig {
  recordHookInstall({
    hookId: "demo-hooks",
    source: "npm",
    spec: params.spec ?? "@openclaw/demo-hooks",
    installPath: params.installPath ?? "/tmp/hooks/demo-hooks",
    ...(params.integrity ? { integrity: params.integrity } : {}),
  });
  return {};
}

function installedPack(version: string, targetDir = "/tmp/hooks/demo-hooks") {
  return { ok: true as const, hookPackId: "demo-hooks", hooks: ["demo"], targetDir, version };
}

const tempDirs = createTrackedTempDirs();

async function packDir(version: string): Promise<string> {
  const dir = await tempDirs.make("openclaw-hook-pack-");
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@openclaw/demo-hooks", version }),
  );
  return dir;
}

describe("updateNpmInstalledHookPacks", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    installNpm.mockReset();
    state = await createOpenClawTestState({ label: "hook-update" });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
    await tempDirs.cleanup();
  });

  it("refuses mutation without both the retained lease and compensation sink", async () => {
    const config = configFor();
    await expect(updateNpmInstalledHookPacks({ config })).rejects.toThrow(
      "hook update lifecycle lease",
    );
    await withPluginLifecycleLease({}, async (lease) => {
      await expect(updateNpmInstalledHookPacks({ config, lease })).rejects.toThrow(
        "hook update transaction sink",
      );
    });
    expect(installNpm).not.toHaveBeenCalled();
  });

  it("aborts exact pinned hook pack updates on integrity drift by default", async () => {
    const warn = vi.fn();
    const error = "aborted: npm package integrity drift detected for @openclaw/demo-hooks@1.0.0";
    installNpm.mockImplementation(async (params: Parameters<typeof installHooksFromNpmSpec>[0]) => {
      const proceed = await params.onIntegrityDrift?.({
        spec: params.spec,
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-new",
        resolution: {
          integrity: "sha512-new",
          resolvedSpec: "@openclaw/demo-hooks@1.0.0",
          version: "1.0.0",
        },
      });
      return proceed === false ? { ok: false, error } : installedPack("1.0.0");
    });

    const config = configFor({
      spec: "@openclaw/demo-hooks@1.0.0",
      integrity: "sha512-old",
    });
    const result = await update({ config, hookIds: ["demo-hooks"], logger: { warn } });

    expect(warn).toHaveBeenCalledWith(
      'Integrity drift for hook pack "demo-hooks" (@openclaw/demo-hooks@1.0.0): expected sha512-old, got sha512-new',
    );
    expect(result.changed).toBe(false);
    expect(result.outcomes).toEqual([
      {
        hookId: "demo-hooks",
        status: "error",
        message: `Failed to update hook pack "demo-hooks": ${error}`,
      },
    ]);
  });

  it("preserves hook pack update selector and records npm resolution metadata after update", async () => {
    installNpm.mockResolvedValue({
      ...installedPack("1.2.3"),
      npmResolution: {
        name: "@openclaw/demo-hooks",
        version: "1.2.3",
        resolvedSpec: "@openclaw/demo-hooks@1.2.3",
        integrity: "sha512-new",
        shasum: "abc123",
        resolvedAt: "2026-05-11T20:00:00.000Z",
      },
    });

    const config = configFor();
    const result = await update({ config, hookIds: ["demo-hooks"] });

    expect(installNpm).toHaveBeenCalledWith(
      expect.objectContaining({ config, expectedHookPackId: "demo-hooks", mode: "update" }),
    );
    expect(result.changed).toBe(true);
    expect(readHookInstalls()["demo-hooks"]).toEqual({
      source: "npm",
      spec: "@openclaw/demo-hooks",
      installPath: "/tmp/hooks/demo-hooks",
      version: "1.2.3",
      resolvedName: "@openclaw/demo-hooks",
      resolvedVersion: "1.2.3",
      resolvedSpec: "@openclaw/demo-hooks@1.2.3",
      integrity: "sha512-new",
      shasum: "abc123",
      resolvedAt: "2026-05-11T20:00:00.000Z",
      hooks: ["demo"],
      installedAt: expect.any(String),
    });
  });

  it.each([
    { dryRun: false, message: 'Downgraded hook pack "demo-hooks": 1.2.3 -> 1.2.2.' },
    { dryRun: true, message: 'Would downgrade hook pack "demo-hooks": 1.2.3 -> 1.2.2.' },
  ])(
    "reports hook pack installs that move backwards as downgrades (dryRun: $dryRun)",
    async ({ dryRun, message }) => {
      const installPath = await packDir("1.2.3");
      installNpm.mockResolvedValue(installedPack("1.2.2", installPath));
      const config = configFor({ installPath });
      const result = await update({ config, hookIds: ["demo-hooks"], dryRun });

      expect(result.outcomes).toEqual([
        {
          hookId: "demo-hooks",
          status: "updated",
          currentVersion: "1.2.3",
          nextVersion: "1.2.2",
          message,
        },
      ]);
    },
  );

  it("restores the payload and record when the caller rolls back its config update", async () => {
    const installPath = await packDir("1.0.0");
    const sourceDir = await packDir("2.0.0");
    const config = configFor({ installPath });
    const previousInstalls = readHookInstalls();
    installNpm.mockImplementation(async (params: Parameters<typeof installHooksFromNpmSpec>[0]) => {
      const result = await installPackageDir(
        copyPackageDirInstallTransactionRequest(params, {
          sourceDir,
          targetDir: installPath,
          mode: "update",
          timeoutMs: 30_000,
          copyErrorPrefix: "hook fixture install failed",
          hasDeps: false,
          depsLogMessage: "",
          beforePersistentApply: params.beforePersistentApply,
        }),
      );
      return result.ok ? { ...result, ...installedPack("2.0.0", installPath) } : result;
    });

    await update({ config, hookIds: ["demo-hooks"] }, "rollback");

    expect(
      JSON.parse(await fs.readFile(path.join(installPath, "package.json"), "utf8")),
    ).toMatchObject({ version: "1.0.0" });
    expect(readHookInstalls()).toEqual(previousInstalls);
  });
});
