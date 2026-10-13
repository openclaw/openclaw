/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

const suggestedProfile = { id: "cloud", providerId: "crabbox", providerDisplayId: "aws" };
const profile = { ...suggestedProfile, executionModes: ["worker-turn"] };

async function fixture(adopt: () => Promise<unknown>) {
  let saved = false;
  const result = createDraftFixture({
    methods: [
      "environments.list",
      "environments.adoptSuggestedProfile",
      "sessions.create",
      "sessions.dispatch",
    ],
    scopes: ["operator.admin", "operator.read", "operator.write"],
    request: async (method) => {
      if (method === "environments.list") {
        return {
          environments: [],
          profiles: saved ? [profile] : [],
          ...(saved ? {} : { suggestedProfile }),
        };
      }
      if (method === "environments.adoptSuggestedProfile") {
        const response = await adopt();
        saved = true;
        return response;
      }
      return {};
    },
  });
  await result.gateway.refreshCloudProfiles();
  return result;
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe("suggested Cloud adoption", () => {
  it("keeps the suggestion undispatchable until adoption saves and selects a configured profile", async () => {
    const adoption = Promise.withResolvers<unknown>();
    const { place, gateway, flow, request } = await fixture(() => adoption.promise);
    flow.setMessage("Prepare this repository");
    expect(gateway.cloudProfiles).toEqual([]);
    expect(gateway.suggestedProfile).toEqual(suggestedProfile);
    const selecting = place.suggestedCloudProfile.adopt();
    expect(place.cloudProfileId).toBe("");
    expect(flow.submitBlock()?.gate).toBe("cloud");
    expect(request).toHaveBeenCalledWith("environments.adoptSuggestedProfile", {});
    expect(request.mock.calls.some(([method]) => method === "sessions.dispatch")).toBe(false);
    adoption.resolve({ profile });
    await selecting;
    expect(place.cloudProfileId).toBe("cloud");
    expect(gateway.cloudProfiles.map((entry) => entry.id)).toEqual(["cloud"]);
    expect(gateway.suggestedProfile).toBeUndefined();
    expect(place.suggestedCloudProfile.pending).toBe(false);
  });

  it("shows the adoption method's error and keeps the current selection", async () => {
    const { place, flow } = await fixture(async () => {
      throw new Error("Crabbox login expired");
    });
    await place.suggestedCloudProfile.adopt();
    expect(flow.error).toBe("Crabbox login expired");
    expect(place.cloudProfileId).toBe("");
    expect(place.suggestedCloudProfile.pending).toBe(false);
  });

  it("does not replace a newer local selection when saving finishes", async () => {
    const adoption = Promise.withResolvers<unknown>();
    const { place, gateway } = await fixture(() => adoption.promise);
    const selecting = place.suggestedCloudProfile.adopt();
    place.selectDevice("");
    adoption.resolve({ profile });
    await selecting;
    expect(place.cloudProfileId).toBe("");
    expect(gateway.cloudProfiles.map((entry) => entry.id)).toEqual(["cloud"]);
  });

  it("discards adoption after the Gateway connection changes", async () => {
    const adoption = Promise.withResolvers<unknown>();
    const { place, gateway, context } = await fixture(() => adoption.promise);
    const selecting = place.suggestedCloudProfile.adopt();
    context.gateway.snapshot.phase = "connecting";
    gateway.synchronize(context.gateway);
    place.invalidateGatewayDiscovery(true);
    adoption.resolve({ profile });
    await selecting;
    expect(place.cloudProfileId).toBe("");
    expect(gateway.cloudProfiles).toEqual([]);
    expect(place.suggestedCloudProfile.pending).toBe(false);
  });
});
