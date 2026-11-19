import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { runWithLocalStateOwner } from "../../cli/local-state-owner.js";
import { assertConfigWriteAllowedInCurrentMode } from "../../config/config-write-guard.js";
import type { ConfigWriteOptions } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { commitConfigWithPendingPluginInstalls } from "../../plugins/install-record-commit.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import type { RuntimeEnv } from "../../runtime.js";
import { classifyConfigSecretTarget } from "../../secrets/config-secret-target.js";
import { getPath, setPathExistingStrict } from "../../secrets/path-utils.js";
import { resolveDefaultSecretProviderAlias } from "../../secrets/ref-contract.js";
import { discoverConfigSecretTargets } from "../../secrets/target-registry.js";

/** Moves new or changed plaintext channel credentials into the protected secret store. */
export async function storeChannelSetupCredentials(params: {
  cfg: OpenClawConfig;
  previousConfig: OpenClawConfig;
  storedNames?: string[];
  beforePersistentEffect?: () => Promise<void>;
  assertCurrent?: () => void;
}): Promise<OpenClawConfig> {
  let sourceConfig = params.cfg;
  for (const target of discoverConfigSecretTargets(sourceConfig)) {
    if (
      target.pathSegments[0] !== "channels" ||
      target.entry.secretShape !== "secret_input" ||
      isDeepStrictEqual(target.value, getPath(params.previousConfig, target.pathSegments)) ||
      !classifyConfigSecretTarget(sourceConfig, target).plaintext
    ) {
      continue;
    }
    // A fresh 128-bit name avoids changing a credential another config key uses.
    const name = `CHANNEL_SETUP_${randomBytes(16).toString("hex").toUpperCase()}`;
    const value = typeof target.value === "string" ? target.value : JSON.stringify(target.value);
    await params.beforePersistentEffect?.();
    if (sourceConfig === params.cfg) {
      // Refuse a known immutable config before leaving a credential it cannot reference.
      assertConfigWriteAllowedInCurrentMode();
    }
    await runWithLocalStateOwner({
      method: "secrets.store.set",
      params: { name, value, kind: "secret" },
      target: target.path,
      assertTargetCurrent: params.assertCurrent,
      runLocal: async ({ env, assertCurrent }) => {
        const { writeSecretStoreEntry } = await import("../../secrets/store/secret-store.js");
        await writeSecretStoreEntry({
          scope: { kind: "team" },
          name,
          value,
          kind: "secret",
          updatedBy: "channel-setup",
          database: { env },
          assertCurrent,
        });
      },
    });
    params.storedNames?.push(name);
    if (sourceConfig === params.cfg) {
      sourceConfig = structuredClone(sourceConfig);
    }
    setPathExistingStrict(sourceConfig, target.pathSegments, {
      source: "store",
      provider: resolveDefaultSecretProviderAlias(sourceConfig, "store", {
        preferFirstProviderForSource: true,
      }),
      id: name,
    });
  }
  return sourceConfig;
}

export async function persistChannelPluginConfig(params: {
  cfg: OpenClawConfig;
  pluginInstalled: boolean;
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
  runtime: RuntimeEnv;
  setup?: {
    previousConfig: OpenClawConfig;
    beforePersistentEffect?: () => Promise<void>;
    assertCurrent?: () => void;
  };
}) {
  const { setup } = params;
  let sourceConfig = params.cfg;
  const storedNames: string[] = [];
  try {
    if (setup) {
      sourceConfig = await storeChannelSetupCredentials({
        cfg: sourceConfig,
        ...setup,
        storedNames,
      });
      await setup.beforePersistentEffect?.();
      setup.assertCurrent?.();
    }
    const committed = await commitConfigWithPendingPluginInstalls({
      sourceConfig,
      baseHash: params.baseHash,
      writeOptions: params.writeOptions,
    });
    if (committed.movedInstallRecords || params.pluginInstalled) {
      await refreshPluginRegistryAfterConfigMutation({
        reason: "source-changed",
        logger: { warn: (message) => params.runtime.log(message) },
      });
    }
    return committed;
  } catch (error) {
    if (storedNames.length > 0) {
      // Publication can fail after writing config; retaining entries keeps any published refs valid.
      params.runtime.log(
        `Channel setup did not complete. Protected credentials remain in the secret store: ${storedNames.join(", ")}. Inspect the config before retrying or removing unused entries.`,
      );
    }
    throw error;
  }
}
