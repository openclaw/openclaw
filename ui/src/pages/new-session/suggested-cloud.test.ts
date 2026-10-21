/* @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

const suggestedProfile = { id: "cloud", providerId: "crabbox", providerDisplayId: "aws" };
const profile = { ...suggestedProfile, executionModes: ["worker-turn"] };
const emptyCatalog = () => ({ environments: [], profiles: [], suggestedProfile });

async function fixture() {
  const adoption = Promise.withResolvers<unknown>();
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
        return saved ? { environments: [], profiles: [profile] } : emptyCatalog();
      }
      if (method === "environments.adoptSuggestedProfile") {
        const response = await adoption.promise;
        saved = true;
        return response;
      }
      return {};
    },
  });
  await result.gateway.refreshCloudProfiles();
  return { ...result, adoption };
}

afterEach(() => [sessionStorage, localStorage].forEach((storage) => storage.clear()));

it.each(["successful save", "save failure", "local reselection", "Gateway reconnection"])(
  "settles suggested Cloud adoption after %s without dispatching or replacing newer intent",
  async (outcome) => {
    const { place, gateway, flow, request, adoption, context } = await fixture();
    flow.setMessage("Prepare this repository");
    expect(gateway).toMatchObject({ cloudProfiles: [], suggestedProfile });
    const selecting = place.suggestedCloudProfile.adopt();
    expect(place.cloudProfileId).toBe("");
    expect(flow.submitBlock()?.gate).toBe("cloud");
    expect(request).toHaveBeenCalledWith("environments.adoptSuggestedProfile", {});
    expect(request.mock.calls.some(([method]) => method === "sessions.dispatch")).toBe(false);
    if (outcome === "local reselection") {
      place.selectDevice("");
    }
    if (outcome === "Gateway reconnection") {
      context.gateway.snapshot.phase = "connecting";
      gateway.synchronize(context.gateway);
      place.invalidateGatewayDiscovery(true);
    }
    if (outcome === "save failure") {
      adoption.reject(new Error("Crabbox login expired"));
    } else {
      adoption.resolve({ profile });
    }
    await selecting;
    expect(place).toMatchObject({
      cloudProfileId: outcome === "successful save" ? "cloud" : "",
      suggestedCloudProfile: { pending: false },
    });
    const saved = outcome === "successful save" || outcome === "local reselection";
    expect(gateway.cloudProfiles.map((entry) => entry.id)).toEqual(saved ? ["cloud"] : []);
    if (saved) {
      expect(gateway.suggestedProfile).toBeUndefined();
    }
    if (outcome === "save failure") {
      expect(flow.error).toBe("Crabbox login expired");
    }
  },
);

it("keeps the adopted profile when an older catalog read finishes", async () => {
  const { place, gateway, request, adoption } = await fixture();
  const staleCatalog = Promise.withResolvers<unknown>();
  request.mockImplementationOnce((method) => {
    expect(method).toBe("environments.list");
    return staleCatalog.promise;
  });
  const refreshing = gateway.refreshCloudProfiles();
  const selecting = place.suggestedCloudProfile.adopt();
  adoption.resolve({ profile });
  await selecting;
  expect(place.cloudProfileId).toBe("cloud");

  staleCatalog.resolve(emptyCatalog());
  await refreshing;
  expect(place.cloudProfileId).toBe("cloud");
  expect(gateway).toMatchObject({ cloudProfiles: [{ id: "cloud" }], suggestedProfile: undefined });
});
