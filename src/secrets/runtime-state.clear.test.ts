import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as diagnostics from "../agents/auth-profiles/legacy-source-diagnostic.js";
import * as authSnapshots from "../agents/auth-profiles/runtime-snapshots.js";
import * as state from "./runtime-state.js";

vi.mock("./runtime.js", () => {
  throw new Error("Lightweight secrets cleanup must not load the resolver runtime");
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => state.clearSecretsRuntimeSnapshotState());

function preparedSnapshot(
  overrides: Partial<state.PreparedSecretsRuntimeSnapshot> = {},
): state.PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: {},
    config: {},
    authStores: [],
    authStoreCredentialsRevision: authSnapshots.getRuntimeAuthProfileStoreCredentialsRevision(),
    authStoreSnapshotsRevision: authSnapshots.getRuntimeAuthProfileStoreSnapshotsRevision(),
    warnings: [],
    webTools: {
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    },
    ...overrides,
  };
}

it("retires migration refusals and the provider publisher before the resolver runtime loads", async () => {
  const agentDir = path.join(tempDirs.make("openclaw-secrets-reset-"), "agent");
  const refusal = new diagnostics.AuthProfileMigrationRequiredError({ agentDir, sources: [] });
  diagnostics.markAuthProfileMigrationRequired(agentDir, refusal);
  const published = vi.fn(async () => {});
  state.registerProviderAuthRuntimeSnapshotActivationOwner({
    runExclusive: (run) => run(),
    isCurrent: () => true,
    assertValid: () => {},
    publish: published,
    onError: (error) => {
      throw error;
    },
  });
  const candidate = {
    snapshot: preparedSnapshot(),
    expectedRevision: state.getActiveSecretsRuntimeSnapshotRevisionState(),
    activateSnapshotIfCurrent: () => true,
  };
  try {
    await expect(state.activateProviderAuthRuntimeSnapshot(candidate)).resolves.toBe(true);
    expect(published).toHaveBeenCalledOnce();
    expect(() => diagnostics.assertAuthProfileMigrationReady(agentDir)).toThrow(refusal);

    state.clearSecretsRuntimeSnapshotState();

    await expect(state.activateProviderAuthRuntimeSnapshot(candidate)).resolves.toBe(true);
    expect(published).toHaveBeenCalledOnce();
    expect(() => diagnostics.assertAuthProfileMigrationReady(agentDir)).not.toThrow();
  } finally {
    state.clearSecretsRuntimeSnapshotState();
    diagnostics.clearAuthProfileMigrationDiagnostics();
  }
});

it("isolates snapshot owners while exposing the active config pair for hot paths", () => {
  const resolvedValue = { nested: ["synthetic-value"] };
  const snapshot = preparedSnapshot({
    sourceConfig: { agents: { list: [{ id: "source" }] } },
    config: { agents: { list: [{ id: "runtime" }] } },
    authStores: [],
    degradedOwners: [
      {
        ownerKind: "provider",
        ownerId: "example",
        state: "unavailable",
        paths: ["models.providers.example.apiKey"],
        refKeys: ["env:default:SYNTHETIC_KEY"],
        reason: "secret provider failed",
        providerFailures: [{ source: "env", provider: "default" }],
      },
    ],
    secretOwners: [
      {
        ownerKind: "provider",
        ownerId: "example",
        refKeys: ["env:default:SYNTHETIC_KEY"],
        resolvedValues: [{ refKey: "env:default:SYNTHETIC_KEY", value: resolvedValue }],
      },
    ],
  });
  const expectedOwners = structuredClone({
    degradedOwners: snapshot.degradedOwners,
    secretOwners: snapshot.secretOwners,
  });

  state.activateSecretsRuntimeSnapshotState({
    snapshot,
    refreshContext: null,
    refreshHandler: null,
  });

  snapshot.degradedOwners![0]!.paths.push("changed-at-source");
  snapshot.degradedOwners![0]!.providerFailures![0]!.provider = "changed-at-source";
  resolvedValue.nested.push("changed-at-source");
  const configSnapshot = state.getActiveSecretsRuntimeConfigSnapshot();
  const fullSnapshot = state.getActiveSecretsRuntimeSnapshotState();

  expect(configSnapshot?.config).not.toBe(fullSnapshot?.config);
  expect(configSnapshot?.sourceConfig).not.toBe(fullSnapshot?.sourceConfig);
  expect(configSnapshot?.config).toEqual(snapshot.config);
  expect(configSnapshot?.sourceConfig).toEqual(snapshot.sourceConfig);
  expect(fullSnapshot).toMatchObject(expectedOwners);

  fullSnapshot!.degradedOwners![0]!.paths.push("changed-by-reader");
  fullSnapshot!.degradedOwners![0]!.providerFailures![0]!.provider = "changed-by-reader";
  fullSnapshot!.secretOwners![0]!.refKeys.push("changed-by-reader");
  const readerValue = fullSnapshot!.secretOwners![0]!.resolvedValues![0]!.value;
  if (!isRecord(readerValue)) {
    throw new Error("expected a structured resolved value");
  }
  readerValue.nested = ["changed-by-reader"];
  expect(state.getActiveSecretsRuntimeSnapshotState()).toMatchObject(expectedOwners);
});
