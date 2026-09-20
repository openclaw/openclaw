import { describe, expect, it } from "vitest";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import {
  findPreparedModelCandidate,
  listModelSetupPrepareOptions,
  preparedModelActivation,
} from "./prepare-options.ts";

function detection(
  candidates: SystemAgentSetupDetectResult["candidates"],
  prepareOptions: NonNullable<SystemAgentSetupDetectResult["prepareOptions"]>,
): SystemAgentSetupDetectResult {
  return {
    candidates,
    unavailableCandidates: [],
    manualProviders: [],
    authOptions: [],
    prepareOptions,
    recommendedInstalls: [],
    workspace: "/tmp/workspace",
    setupComplete: false,
  };
}

describe("model setup prepare options", () => {
  it.each([undefined, "utility"] as const)(
    "encodes prepared activation for target %s",
    (modelTarget) => {
      const choiceId = "vendor/local:v1%beta?x#y";
      const kind = "provider-auto:vendor%2Flocal%3Av1%25beta%3Fx%23y";
      const option = { id: choiceId, brandId: "vendor", label: "Vendor Local", modelTarget };
      const activation = preparedModelActivation(option, "vendor/model");
      expect(activation).toEqual(
        modelTarget
          ? { kind, modelRef: "vendor/model", modelTarget: "utility" }
          : { kind, modelRef: "vendor/model" },
      );
      const candidate: SystemAgentSetupDetectResult["candidates"][number] = {
        kind,
        brandId: "vendor",
        label: "Vendor Local",
        detail: "available locally",
        modelRef: "vendor/model",
        recommended: false,
        credentials: true,
      };
      const result = detection([candidate], [option]);

      expect(listModelSetupPrepareOptions(result)).toEqual([]);
      expect(findPreparedModelCandidate(result, choiceId)).toEqual(candidate);
    },
  );

  it("does not treat raw reserved choice ids as canonical kinds", () => {
    const result = detection(
      [
        {
          kind: "provider-auto:local/provider%beta",
          label: "Local Provider",
          detail: "available locally",
          modelRef: "local/model",
          recommended: false,
          credentials: true,
        },
      ],
      [],
    );
    expect(findPreparedModelCandidate(result, "local/provider%beta")).toBeUndefined();
  });

  it("uses provider identity to hide a usable aliased provider", () => {
    const result = detection(
      [
        {
          kind: "provider-auto:other-choice",
          brandId: "lmstudio",
          label: "LM Studio",
          detail: "available locally",
          modelRef: "lmstudio/qwen3-8b-instruct",
          recommended: false,
          credentials: true,
        },
      ],
      [{ id: "lmstudio-local", brandId: "lmstudio", label: "LM Studio" }],
    );

    expect(listModelSetupPrepareOptions(result)).toEqual([]);
  });

  it("keeps setup available for credential-less candidates", () => {
    const result = detection(
      [
        {
          kind: "provider-auto:lmstudio",
          brandId: "lmstudio",
          label: "LM Studio",
          detail: "API key required",
          modelRef: "lmstudio/qwen3-8b-instruct",
          recommended: false,
          credentials: false,
        },
      ],
      [{ id: "lmstudio", brandId: "lmstudio", label: "LM Studio" }],
    );

    expect(listModelSetupPrepareOptions(result)).toHaveLength(1);
    expect(findPreparedModelCandidate(result, "lmstudio")).toBeUndefined();
  });
});
