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

it.each([
  ["successful save", "cloud", [profile], undefined, null],
  ["save failure", "", [], suggestedProfile, "Crabbox login expired"],
  ["local reselection", "", [profile], undefined, null],
  ["Gateway reconnection", "", [], undefined, null],
] as const)(
  "settles suggested Cloud adoption after %s without dispatching or replacing newer intent",
  async (outcome, cloudProfileId, cloudProfiles, suggestion, error) => {
    const { place, gateway, flow, request, adoption, context } = await fixture();
    flow.setMessage("Prepare this repository");
    const selecting = place.suggestedCloudProfile.adopt();
    expect(place.cloudProfileId).toBe("");
    expect(flow.submitBlock()?.gate).toBe("cloud");
    expect(request.mock.calls.some(([method]) => method === "sessions.dispatch")).toBe(false);
    if (outcome === "local reselection") {
      place.selectDevice("");
    }
    if (outcome === "Gateway reconnection") {
      context.gateway.snapshot.phase = "connecting";
      gateway.synchronize(context.gateway);
      place.invalidateGatewayDiscovery(true);
    }
    adoption.resolve(error ? Promise.reject(new Error(error)) : { profile });
    await selecting;
    expect(place).toMatchObject({
      cloudProfileId,
      suggestedCloudProfile: { pending: false },
    });
    expect(gateway).toMatchObject({ cloudProfiles, suggestedProfile: suggestion });
    expect(flow.error).toBe(error);
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
  staleCatalog.resolve(emptyCatalog());
  await refreshing;
  expect(place.cloudProfileId).toBe("cloud");
  expect(gateway).toMatchObject({ cloudProfiles: [{ id: "cloud" }], suggestedProfile: undefined });
});
