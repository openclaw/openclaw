import { vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  prepareRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyRuntimeWebToolsMetadata } from "../secrets/runtime-fast-path.js";
import type { PreparedSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";

export function createTestRuntimeSecretsActivator(
  prepareRuntimeSecretsSnapshot: NonNullable<
    Parameters<typeof createRuntimeSecretsActivator>[0]["prepareRuntimeSecretsSnapshot"]
  > = async () => {
    throw new Error("Unexpected secrets preparation");
  },
) {
  return createRuntimeSecretsActivator({
    logSecrets: createInfoWarnErrorLogger(),
    emitStateEvent: vi.fn(),
    prepareRuntimeSecretsSnapshot,
  });
}

export function createMockRuntimeSecretsActivator(
  prepare: (config: OpenClawConfig) => Promise<PreparedSecretsRuntimeSnapshot> = async (config) =>
    makePreparedSecretsSnapshot(config),
) {
  const prepareSnapshot = vi.fn<
    NonNullable<Parameters<typeof createTestRuntimeSecretsActivator>[0]>
  >(({ config }) => prepare(config));
  const owner = createTestRuntimeSecretsActivator(prepareSnapshot);
  return Object.assign(owner, { prepareSnapshot });
}

export function makePreparedSecretsSnapshot(
  config: OpenClawConfig,
  overrides: Omit<Partial<PreparedSecretsRuntimeSnapshot>, "authStores"> & {
    authStores?: Parameters<typeof prepareRuntimeAuthProfileStoreSnapshots>[0];
  } = {},
): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: config,
    config,
    authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
    authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
    warnings: [],
    webTools: createEmptyRuntimeWebToolsMetadata(),
    ...overrides,
    authStores: prepareRuntimeAuthProfileStoreSnapshots(overrides.authStores ?? []),
  };
}
