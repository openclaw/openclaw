/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleModelCatalogRequests } from "../../lib/model-catalog-store.ts";
import { readDraftCloudProfiles } from "./discovery.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

const runtime = {
  id: "openclaw",
  source: "model" as const,
  cloudPlacementSupported: true,
  cloudPlacementExecutionMode: "worker-turn" as const,
  devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
};

async function fixture(reason: "missing-auth" | "auth-failed" = "missing-auth") {
  const result = createDraftFixture({
    methods: ["environments.list", "sessions.create", "sessions.dispatch"],
    scopes: ["operator.admin", "operator.read", "operator.write"],
    agents: [
      {
        id: "main",
        workspace: "/workspace",
        model: { primary: "openai/gpt-4.1-mini" },
        agentRuntime: runtime,
      },
    ],
    modelCatalog: async () => ({
      models: [
        {
          id: "gpt-4.1-mini",
          name: "GPT-4.1 mini",
          provider: "openai",
          available: false,
          unavailableReason: reason,
          agentRuntime: runtime,
        },
      ],
    }),
    request: async (method) =>
      method === "environments.list"
        ? {
            environments: [
              {
                id: "node:paired",
                type: "node",
                label: "Paired worker",
                status: "available",
                sessionHost: true,
                workerSlots: { total: 1, available: 1 },
              },
            ],
            profiles: [
              {
                id: "direct",
                providerId: "device",
                executionModes: ["worker-turn"],
                inference: "worker",
              },
              { id: "proxied", providerId: "device", executionModes: ["worker-turn"] },
              {
                id: "raw-settings",
                providerId: "device",
                executionModes: ["worker-turn"],
                settings: { inference: "worker" },
              },
            ],
          }
        : {},
  });
  await Promise.all([
    result.gateway.refreshCloudProfiles(),
    settleModelCatalogRequests(result.context.gateway.snapshot.client!, { agentId: "main" }),
  ]);
  result.flow.setMessage("Check the workspace");
  expect(result.place.modelControl.modelUnavailableReason(result.place.selectedAgent())).toBe(
    reason,
  );
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe("worker inference New Session scope", () => {
  it("retains only the published worker inference fact, never raw settings", () => {
    const profiles = readDraftCloudProfiles([
      {
        id: "direct",
        providerId: "device",
        inference: "worker",
        settings: { token: "synthetic-private-value" },
      },
      { id: "gateway", providerId: "device", inference: "gateway" },
      {
        id: "unknown",
        providerId: "device",
        inference: "remote",
        settings: { inference: "worker" },
      },
    ]);
    expect(profiles[0]).toMatchObject({ id: "direct", inference: "worker" });
    expect(profiles.every((profile) => !Object.hasOwn(profile, "settings"))).toBe(true);
    expect(profiles.slice(1).every((profile) => !Object.hasOwn(profile, "inference"))).toBe(true);
  });

  it.each(["missing-auth", "auth-failed"] as const)(
    "uses worker credentials only for the selected direct profile (%s)",
    async (reason) => {
      const { flow, place } = await fixture(reason);
      expect(flow.submitBlock()?.gate).toBe("model-unavailable");
      place.selectCloudProfile("direct");
      expect(flow.canSubmit()).toBe(true);
      expect(place.modelControl.modelForSubmission()).toBe("");
      place.selectCloudProfile("proxied");
      expect(flow.submitBlock()?.gate).toBe("model-unavailable");
      place.selectCloudProfile("raw-settings");
      expect(flow.submitBlock()?.gate).toBe("model-unavailable");
      place.selectDevice("paired");
      expect(flow.submitBlock()?.gate).toBe("model-unavailable");
      place.selectDevice("");
      expect(flow.submitBlock()?.gate).toBe("model-unavailable");
      place.selectCloudProfile("direct");
      expect(flow.canSubmit()).toBe(true);
    },
  );

  it("preserves explicit model/runtime validation instead of discarding a selection", async () => {
    const { flow, place } = await fixture();
    place.selectCloudProfile("direct");
    place.modelControl.selected = "openai/gpt-4.1-mini";
    place.modelControl.agentRuntime = "openclaw";
    expect(flow.submitBlock()?.gate).toBe("model-unavailable");
    expect(place.modelControl.modelForSubmission()).toBe("openai/gpt-4.1-mini");
    place.modelControl.agentRuntime = "unavailable-runtime";
    expect(flow.submitBlock()?.gate).toBe("model-unavailable");
  });

  it("still waits for current agent defaults on a worker-inference profile", async () => {
    const { flow, place, context } = await fixture();
    place.selectCloudProfile("direct");
    context.agents.state.agentsListCached = true;
    expect(flow.submitBlock()?.gate).toBe("agents");
    context.agents.state.agentsListCached = false;
    expect(flow.canSubmit()).toBe(true);
  });

  it("does not relax Gateway permission checks for worker inference", async () => {
    const { flow, place, context } = await fixture();
    place.selectCloudProfile("direct");
    context.gateway.snapshot.hello!.auth!.scopes = ["operator.read"];
    expect(flow.submitBlock()?.gate).toBe("access");
  });
});

it.each(["remote-exec", "other-worker-turn", "unresolved"] as const)(
  "does not apply the worker credential exception to a %s runtime",
  async (mode) => {
    const { flow, place } = await fixture();
    place.selectCloudProfile("direct");
    vi.spyOn(place.modelControl, "resolveAgentRuntime").mockReturnValue(
      mode === "unresolved"
        ? undefined
        : {
            ...runtime,
            id: "external-runtime",
            cloudPlacementExecutionMode: mode === "remote-exec" ? mode : "worker-turn",
          },
    );
    expect(flow.submitBlock()?.gate).toBe("model-unavailable");
  },
);
