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

// mock-isolation: Update fixtures control installation outcomes without registry access.
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

  it.each([
    ["1.0.0", "1.2.3", false, "commit", "Updated"],
    ["1.2.3", "1.2.2", false, "commit", "Downgraded"],
    ["1.2.3", "1.2.2", true, "commit", "Would downgrade"],
    ["1.0.0", "2.0.0", false, "rollback", "Updated"],
  ] as const)("updates %s to %s (dry=%s, %s)", async (current, next, dryRun, action, verb) => {
    const installPath = await packDir(current);
    const sourceDir = await packDir(next);
    const config = configFor({ installPath });
    const previous = readHookInstalls();
    const resolution = {
      name: "@openclaw/demo-hooks",
      version: next,
      resolvedSpec: `@openclaw/demo-hooks@${next}`,
      integrity: "sha512-new",
      shasum: "abc123",
      resolvedAt: "2026-05-11T20:00:00.000Z",
    };
    installNpm.mockImplementation(async (params: Parameters<typeof installHooksFromNpmSpec>[0]) => {
      const result = params.dryRun
        ? { ok: true as const }
        : await installPackageDir(
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
      return result.ok
        ? { ...result, ...installedPack(next, installPath), npmResolution: resolution }
        : result;
    });
    const result = await update({ config, hookIds: ["demo-hooks"], dryRun }, action);
    expect(installNpm).toHaveBeenCalledWith(
      expect.objectContaining({ config, expectedHookPackId: "demo-hooks", mode: "update" }),
    );
    expect(result.changed).toBe(!dryRun);
    expect(result.outcomes).toEqual([
      {
        hookId: "demo-hooks",
        status: "updated",
        currentVersion: current,
        nextVersion: next,
        message: `${verb} hook pack "demo-hooks": ${current} -> ${next}.`,
      },
    ]);
    if (dryRun || action === "rollback") {
      expect(readHookInstalls()).toEqual(previous);
    } else {
      expect(readHookInstalls()["demo-hooks"]).toEqual({
        source: "npm",
        spec: "@openclaw/demo-hooks",
        installPath,
        version: next,
        resolvedName: resolution.name,
        resolvedVersion: next,
        resolvedSpec: resolution.resolvedSpec,
        integrity: "sha512-new",
        shasum: "abc123",
        resolvedAt: resolution.resolvedAt,
        hooks: ["demo"],
        installedAt: expect.any(String),
      });
    }
    expect(
      JSON.parse(await fs.readFile(path.join(installPath, "package.json"), "utf8")),
    ).toMatchObject({ version: dryRun || action === "rollback" ? current : next });
  });
});
