import path from "node:path";
import { root } from "../infra/fs-safe.js";
import { createConfigIoContext } from "./io.context.js";
import { captureConfigHealthStateStore } from "./io.health-state.js";
import { loadConfigFromContext, loadConfigFromContextAsync } from "./io.load.js";
import {
  commitConfigRecoveryFile,
  createConfigRecoverySourceGuard,
} from "./io.observe-recovery-effects.js";
import { recoverConfigFromLastKnownGoodCore } from "./io.observe-recovery.js";
import { createConfigHealthFingerprint, readConfigHealthEntry } from "./io.observe-state.js";
import { resolveConfigObserveSuspiciousReasons } from "./io.observe-suspicious.js";
import { recoverConfigFromJsonRootSuffixWithContext } from "./io.recovery.js";
import {
  prepareConfigRecoveryFromContext,
  readBestEffortConfigSnapshotFromContext,
  readConfigFileSnapshotForWriteFromContext,
  readConfigFileSnapshotFromContext,
  readConfigFileSnapshotInternal,
  readConfigFileSnapshotWithPluginMetadataFromContext,
  readSourceConfigBestEffortFromContext,
} from "./io.snapshot.js";
import type {
  ConfigIoFactoryOptions,
  ConfigSnapshotReadOptions,
  ConfigSnapshotMetadataReadOptions,
} from "./io.types.js";
import { chmodConfigBestEffort } from "./io.write-safety.js";
import type { writeConfigFileFromContext } from "./io.write.js";
import { resolveIsConfigReadOnly } from "./paths.js";
import { collectPollutedSecretPlaceholders } from "./recovery-policy.js";
import type { ConfigFileSnapshot } from "./types.js";
import { withConfigWriteLock } from "./write-lock.js";

export function createConfigIO(options: ConfigIoFactoryOptions = {}) {
  const context = createConfigIoContext(options);
  const readInternal = (observe?: boolean) =>
    readConfigFileSnapshotInternal(
      observe === false ? { ...context, deps: { ...context.deps, observe: false } } : context,
    );
  return {
    configPath: context.configPath,
    env: context.deps.env,
    logger: context.deps.logger,
    loadConfig: (loadOptions?: { skipSuspiciousRecovery?: boolean }) =>
      loadConfigFromContext(context, loadOptions),
    loadConfigAsync: (loadOptions?: Parameters<typeof loadConfigFromContextAsync>[1]) =>
      loadConfigFromContextAsync(context, loadOptions),
    readBestEffortConfig: async () =>
      (await readBestEffortConfigSnapshotFromContext(context)).config,
    readBestEffortConfigSnapshot: () => readBestEffortConfigSnapshotFromContext(context),
    readSourceConfigBestEffort: () => readSourceConfigBestEffortFromContext(context),
    readConfigFileSnapshot: (readOptions: ConfigSnapshotReadOptions = {}) =>
      readConfigFileSnapshotFromContext(context, readOptions),
    readConfigFileSnapshotFromRaw: async (sourceRaw: string) =>
      (await readConfigFileSnapshotInternal(context, {}, sourceRaw)).snapshot,
    readConfigFileSnapshotWithPluginMetadata: (
      readOptions: ConfigSnapshotMetadataReadOptions = {},
    ) => readConfigFileSnapshotWithPluginMetadataFromContext(context, readOptions),
    readConfigFileSnapshotForWrite: (readOptions?: Pick<ConfigSnapshotReadOptions, "observe">) =>
      readConfigFileSnapshotForWriteFromContext(context, readOptions),
    prepareConfigRecovery: (current: ConfigFileSnapshot) =>
      prepareConfigRecoveryFromContext(context, current),
    /** True reports committed file work; health metadata remains best-effort. */
    promoteConfigSnapshotToLastKnownGood: async (
      snapshot: ConfigFileSnapshot,
    ): Promise<boolean> => {
      const { deps } = context;
      if (resolveIsConfigReadOnly(deps.env)) {
        return false;
      }
      if (!snapshot.exists || !snapshot.valid || typeof snapshot.raw !== "string") {
        return false;
      }
      const polluted = collectPollutedSecretPlaceholders(snapshot.parsed);
      if (polluted.length > 0) {
        deps.logger.warn(
          `Config last-known-good promotion skipped: redacted secret placeholder at ${polluted[0]}`,
        );
        return false;
      }
      const health = captureConfigHealthStateStore(deps, snapshot.path);
      const healthSnapshot = await health.read();
      const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
      const now = new Date().toISOString();
      const current = createConfigHealthFingerprint({
        raw: snapshot.raw,
        parsed: snapshot.parsed,
        resolved: snapshot.resolved,
        stat,
        observedAt: now,
      });
      const lastGoodPath = `${snapshot.path}.last-good`;
      health.assertCurrent();
      const entry = readConfigHealthEntry(healthSnapshot.state, snapshot.path);
      const suspiciousReasons = resolveConfigObserveSuspiciousReasons({
        hash: current.hash,
        lastObservedSuspiciousSignature: entry.lastObservedSuspiciousSignature,
        bytes: current.bytes,
        gatewayMode: current.gatewayMode,
        parsed: snapshot.parsed,
        lastKnownGood: entry.lastKnownGood,
      });
      if (suspiciousReasons.length > 0) {
        deps.logger.warn(
          `Config last-known-good promotion skipped: ${snapshot.path} (${suspiciousReasons.join(", ")})`,
        );
        return false;
      }
      const raw = snapshot.raw;
      const assertUnchanged = createConfigRecoverySourceGuard(deps, [[snapshot.path, raw, stat]]);
      await commitConfigRecoveryFile({
        health,
        beforeCommit: assertUnchanged,
        write: async (assertCurrent) => {
          const directory = await root(path.dirname(lastGoodPath));
          await directory.write(path.basename(lastGoodPath), raw, {
            mkdir: false,
            mode: 0o600,
            durable: false,
            encoding: "utf8",
            overwrite: true,
            assertBeforeMutation: assertCurrent,
          });
        },
      });
      await chmodConfigBestEffort({
        deps,
        configPath: lastGoodPath,
        context: "last-known-good promotion",
      });
      await health.updateAfterFileCommit(
        {
          lastKnownGood: current,
          lastPromotedGood: current,
          lastObservedSuspiciousSignature: null,
        },
        healthSnapshot,
      );
      return true;
    },
    recoverConfigFromLastKnownGood: (params: { snapshot: ConfigFileSnapshot; reason: string }) =>
      recoverConfigFromLastKnownGoodCore({
        deps: context.deps,
        snapshot: params.snapshot,
        reason: params.reason,
        prepareCandidate: context.prepareRecoveryBackupCandidate,
      }),
    recoverConfigFromJsonRootSuffix: (
      snapshot: ConfigFileSnapshot,
      assertRecoveryCandidate?: (config: unknown) => void,
    ) => recoverConfigFromJsonRootSuffixWithContext(context, snapshot, assertRecoveryCandidate),
    writeConfigFile: async (
      config: Parameters<typeof writeConfigFileFromContext>[1],
      writeOptions: Parameters<typeof writeConfigFileFromContext>[2] = {},
    ) => {
      writeOptions.assertConfigPathForWrite?.();
      const { writeConfigFileFromContext } = await import("./io.write.js");
      writeOptions.assertConfigPathForWrite?.();
      return withConfigWriteLock(
        context.configPath,
        () =>
          writeConfigFileFromContext(context, config, writeOptions, () =>
            readInternal(writeOptions.observe),
          ),
        context.deps.env,
        writeOptions.assertCurrent,
      );
    },
  };
}
