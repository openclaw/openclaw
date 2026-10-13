// CLI persistence for hook-pack installs.
import { replaceConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { stageHookInstall } from "../hooks/install-record-transaction.js";
import type { HookInstallUpdate } from "../hooks/installs.js";
import type { PackageDirInstallTransaction } from "../infra/install-package-dir.js";
import type { ConfigSnapshotForInstallPersist } from "../plugins/install-config-mutation.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export async function persistHookPackInstall(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  hookPackId: string;
  hooks: string[];
  install: Omit<HookInstallUpdate, "hookId" | "hooks">;
  successMessage?: string;
  runtime?: RuntimeEnv;
  beforePersistentApply?: () => void;
  payloadTransaction?: PackageDirInstallTransaction;
}): Promise<OpenClawConfig> {
  const runtime = params.runtime ?? defaultRuntime;
  return await withPluginLifecycleLease({}, async (lease) => {
    const assertPersistentApply = () => {
      lease.assertOwned();
      params.snapshot.writeOptions.assertConfigPathForWrite?.();
      params.beforePersistentApply?.();
    };
    const config = params.snapshot.config;
    const entries = { ...config.hooks?.internal?.entries };
    for (const hookName of params.hooks) {
      entries[hookName] = { ...entries[hookName], enabled: true };
    }
    const next: OpenClawConfig = {
      ...config,
      hooks: {
        ...config.hooks,
        internal: {
          ...config.hooks?.internal,
          enabled: true,
          entries,
        },
      },
    };
    const transaction = await stageHookInstall({
      update: { hookId: params.hookPackId, hooks: params.hooks, ...params.install },
      payloadTransaction: params.payloadTransaction,
      lease,
      beforePersistentApply: assertPersistentApply,
    });
    try {
      await replaceConfigFile({
        nextConfig: next,
        baseHash: params.snapshot.baseHash,
        writeOptions: {
          ...params.snapshot.writeOptions,
          assertConfigPathForWrite: assertPersistentApply,
        },
      });
    } catch (error) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Hook install config rollback failed", {
          cause: rollbackError,
        });
      }
      throw error;
    }
    await transaction.commit();
    runtime.log(params.successMessage ?? `Installed hook pack: ${params.hookPackId}`);
    runtime.log(
      "Hook install/link config can activate immediately in hybrid mode; code-only updates and reload mode off need a Gateway restart.",
    );
    return next;
  });
}
