import { describe, expect, it } from "vitest";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import {
  findPreparedModelCandidate,
  listModelSetupPrepareOptions,
  preparedModelActivation,
} from "./prepare-options.ts";

function detection(
  candidates: SystemAgentSetupDetectResult["candidates"],
  prepareOptions: SystemAgentSetupDetectResult["prepareOptions"],
): SystemAgentSetupDetectResult {
  return {
    candidates,
    manualProviders: [],
    prepareOptions,
    workspace: "/tmp/workspace",
    setupComplete: false,
  };
}

type Candidate = SystemAgentSetupDetectResult["candidates"][number];
function candidate(kind: Candidate["kind"], modelRef: string, credentials = true): Candidate {
  return {
    kind,
    modelRef,
    credentials,
    label: "Local Provider",
    detail: "available locally",
    recommended: false,
  };
}

describe("model setup prepare options", () => {
  it.each([{ prepareOptions: undefined }, { prepareOptions: [] }])(
    "does not invent preparation choices when discovery returns $prepareOptions",
    ({ prepareOptions }) => {
      expect(listModelSetupPrepareOptions(detection([], prepareOptions))).toEqual([]);
    },
  );

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
      const prepared = candidate(kind, "vendor/model");
      const result = detection([prepared], [option]);

      expect(listModelSetupPrepareOptions(result)).toEqual([]);
      expect(findPreparedModelCandidate(result, choiceId)).toEqual(prepared);
    },
  );

  it("does not treat raw reserved choice ids as canonical kinds", () => {
    const result = detection([candidate("provider-auto:local/provider%beta", "local/model")], []);
    expect(findPreparedModelCandidate(result, "local/provider%beta")).toBeUndefined();
  });

  it.each([
    { credentials: true, kind: "provider-auto:other-choice", id: "lmstudio-local", count: 0 },
    { credentials: false, kind: "provider-auto:lmstudio", id: "lmstudio", count: 1 },
  ] as const)(
    "offers preparation only without usable credentials (credentials=$credentials)",
    ({ credentials, kind, id, count }) => {
      const result = detection(
        [candidate(kind, "lmstudio/qwen3-8b-instruct", credentials)],
        [{ id, brandId: "lmstudio", label: "LM Studio" }],
      );
      expect(listModelSetupPrepareOptions(result)).toHaveLength(count);
      expect(findPreparedModelCandidate(result, id)).toBeUndefined();
    },
  );
});
