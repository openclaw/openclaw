import { afterEach, describe, expect, it } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
} from "../agents/auth-profiles/runtime-snapshots.js";
import { createEmptyRuntimeWebToolsMetadata } from "../secrets/runtime-fast-path.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
} from "../secrets/runtime.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";

function claimGeneration(
  state: SharedGatewaySessionGenerationState,
  generation: string | undefined,
) {
  const ownership = state.claim(state.capture(), generation);
  if (!ownership) {
    throw new Error("expected generation ownership claim");
  }
  return ownership;
}

describe("shared gateway generation publication", () => {
  afterEach(() => {
    clearSecretsRuntimeSnapshot();
  });

  it("normalizes a matching required marker after a same-generation refresh", () => {
    const state = new SharedGatewaySessionGenerationState({
      current: "generation-a",
      required: "generation-a",
    });
    const ownership = claimGeneration(state, "generation-a");
    const snapshot = {
      sourceConfig: {},
      config: {},
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
      warnings: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
    };
    activateSecretsRuntimeSnapshot(snapshot);
    const publishedRevision = getActiveSecretsRuntimeSnapshotRevision();
    activateSecretsRuntimeSnapshot(snapshot);

    expect(getActiveSecretsRuntimeSnapshotRevision()).toBeGreaterThan(publishedRevision);

    expect(state.finalize(ownership)).toBe(true);
    expect({ current: state.current, required: state.required }).toEqual({
      current: "generation-a",
      required: null,
    });
  });

  it("does not clear a same-generation required marker owned by a newer config write", () => {
    const state = new SharedGatewaySessionGenerationState({
      current: "generation-a",
      required: "generation-a",
    });
    const ownership = claimGeneration(state, "generation-a");
    enforceSharedGatewaySessionGenerationForConfigWrite({
      state,
      nextConfig: { gateway: { reload: { mode: "off" } } },
      resolveRuntimeSnapshotGeneration: () => "generation-a",
      clients: [],
    });

    expect(state.finalize(ownership)).toBe(false);
    expect({ current: state.current, required: state.required }).toEqual({
      current: "generation-a",
      required: "generation-a",
    });
  });

  it("clears the previous required generation after a credential rotation commits", () => {
    const state = new SharedGatewaySessionGenerationState({
      current: "generation-a",
      required: "generation-a",
    });
    const ownership = claimGeneration(state, "generation-b");

    expect(state.finalize(ownership)).toBe(true);
    expect({ current: state.current, required: state.required }).toEqual({
      current: "generation-b",
      required: null,
    });
  });

  it("does not overwrite a newer published generation", () => {
    const state = new SharedGatewaySessionGenerationState({
      current: "generation-a",
      required: "generation-a",
    });
    const ownership = claimGeneration(state, "generation-a");
    enforceSharedGatewaySessionGenerationForConfigWrite({
      state,
      nextConfig: { gateway: { reload: { mode: "off" } } },
      resolveRuntimeSnapshotGeneration: () => "generation-b",
      clients: [],
    });

    expect(state.finalize(ownership)).toBe(false);
    expect({ current: state.current, required: state.required }).toEqual({
      current: "generation-b",
      required: "generation-b",
    });
  });

  it("rejects a stale restart marker after a newer config write", () => {
    const state = new SharedGatewaySessionGenerationState({
      current: "generation-a",
      required: null,
    });
    const restartOwnership = state.capture();
    enforceSharedGatewaySessionGenerationForConfigWrite({
      state,
      nextConfig: { gateway: { reload: { mode: "off" } } },
      resolveRuntimeSnapshotGeneration: () => "generation-b",
      clients: [],
    });

    expect(state.setRequired(restartOwnership, "generation-a")).toBeNull();
    expect({ current: state.current, required: state.required }).toEqual({
      current: "generation-b",
      required: "generation-b",
    });
  });
});
