import { afterEach, describe, expect, it, vi } from "vitest";
import * as providerNormalization from "../agents/provider-model-normalization.runtime.js";
import * as manifestEligibility from "../plugins/manifest-contract-eligibility.js";
import { resolveSessionDisplayModelRef } from "./sessions-display-model.js";

afterEach(() => vi.restoreAllMocks());

describe("session display model isolation", () => {
  it("resolves a qualified alias without discovering manifests or invoking provider hooks", () => {
    const discover = vi
      .spyOn(manifestEligibility, "loadManifestMetadataSnapshot")
      .mockImplementation(() => {
        throw new Error("session display must not discover manifests");
      });
    const normalize = vi
      .spyOn(providerNormalization, "normalizeProviderModelIdWithRuntime")
      .mockImplementation(() => {
        throw new Error("session display must not invoke provider hooks");
      });

    expect(
      resolveSessionDisplayModelRef(
        {
          agents: {
            defaults: {
              model: { primary: "external/selected" },
              models: { "custom/actual-model": { alias: "external/selected" } },
            },
          },
        },
        { key: "agent:main:new" },
      ),
    ).toEqual({ provider: "custom", model: "actual-model" });
    expect(discover).not.toHaveBeenCalled();
    expect(normalize).not.toHaveBeenCalled();
  });
});
