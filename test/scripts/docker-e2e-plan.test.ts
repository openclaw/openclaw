import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_RETRIES,
  RELEASE_PATH_PROFILE,
  parseLaneSelection,
  resolveDockerE2ePlan,
} from "../../scripts/lib/docker-e2e-plan.mjs";

const orderLanes = <T>(lanes: T[]) => lanes;

function planFor(
  overrides: Partial<Parameters<typeof resolveDockerE2ePlan>[0]> = {},
): ReturnType<typeof resolveDockerE2ePlan>["plan"] {
  return resolveDockerE2ePlan({
    includeOpenWebUI: false,
    liveMode: "all",
    liveRetries: DEFAULT_LIVE_RETRIES,
    orderLanes,
    planReleaseAll: false,
    profile: "all",
    releaseChunk: "core",
    selectedLaneNames: [],
    timingStore: undefined,
    ...overrides,
  }).plan;
}

describe("scripts/lib/docker-e2e-plan", () => {
  it("plans the full release path against package-backed e2e images", () => {
    const plan = planFor({
      includeOpenWebUI: false,
      planReleaseAll: true,
      profile: RELEASE_PATH_PROFILE,
    });

    expect(plan.needs).toMatchObject({
      bareImage: true,
      e2eImage: true,
      functionalImage: true,
      liveImage: false,
      package: true,
    });
    expect(plan.credentials).toEqual(["anthropic", "openai"]);
    expect(plan.lanes.map((lane) => lane.name)).toContain("install-e2e-openai");
    expect(plan.lanes.map((lane) => lane.name)).toContain("install-e2e-anthropic");
    expect(plan.lanes.map((lane) => lane.name)).toContain("mcp-channels");
    expect(plan.lanes.map((lane) => lane.name)).toContain("bundled-channel-feishu");
    expect(plan.lanes.map((lane) => lane.name)).toContain("bundled-channel-update-acpx");
    expect(plan.lanes.map((lane) => lane.name)).toContain("bundled-plugin-install-uninstall-0");
    expect(plan.lanes.map((lane) => lane.name)).toContain("bundled-plugin-install-uninstall-7");
    expect(plan.lanes.map((lane) => lane.name)).not.toContain("bundled-plugin-install-uninstall");
    expect(plan.lanes.map((lane) => lane.name)).not.toContain("bundled-channel-deps");
    expect(plan.lanes.map((lane) => lane.name)).not.toContain("openwebui");
  });

  it("plans Open WebUI only when release-path coverage requests it", () => {
    const withoutOpenWebUI = planFor({
      includeOpenWebUI: false,
      planReleaseAll: true,
      profile: RELEASE_PATH_PROFILE,
    });
    const withOpenWebUI = planFor({
      includeOpenWebUI: true,
      planReleaseAll: true,
      profile: RELEASE_PATH_PROFILE,
    });

    expect(withoutOpenWebUI.lanes.map((lane) => lane.name)).not.toContain("openwebui");
    expect(withOpenWebUI.lanes.map((lane) => lane.name)).toContain("openwebui");
  });

  it("splits the old plugins/integrations release chunk across plugin and bundled-channel chunks", () => {
    const pluginsRuntime = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "plugins-runtime",
    });
    const bundledChannels = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "bundled-channels",
    });

    expect(pluginsRuntime.lanes.map((lane) => lane.name)).toEqual(
      expect.arrayContaining([
        "plugins",
        "bundled-plugin-install-uninstall-0",
        "bundled-plugin-install-uninstall-7",
        "cron-mcp-cleanup",
        "openai-web-search-minimal",
        "openwebui",
      ]),
    );
    expect(pluginsRuntime.lanes.map((lane) => lane.name)).not.toContain("bundled-channel-telegram");
    expect(bundledChannels.lanes.map((lane) => lane.name)).toEqual(
      expect.arrayContaining([
        "plugin-update",
        "bundled-channel-telegram",
        "bundled-channel-update-acpx",
      ]),
    );
    expect(bundledChannels.lanes.map((lane) => lane.name)).not.toContain("plugins");
    expect(bundledChannels.lanes.map((lane) => lane.name)).not.toContain("openwebui");
  });

  it("keeps the legacy plugins-integrations release chunk as an aggregate alias", () => {
    const legacy = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "plugins-integrations",
    });

    expect(legacy.lanes.map((lane) => lane.name)).toEqual(
      expect.arrayContaining([
        "plugins",
        "bundled-plugin-install-uninstall-0",
        "plugin-update",
        "bundled-channel-update-acpx",
        "openwebui",
      ]),
    );
  });

  it("plans a live-only selected lane without package e2e images", () => {
    const plan = planFor({ selectedLaneNames: ["live-models"] });

    expect(plan.lanes.map((lane) => lane.name)).toEqual(["live-models"]);
    expect(plan.needs).toMatchObject({
      bareImage: false,
      e2eImage: false,
      functionalImage: false,
      liveImage: true,
      package: false,
    });
  });

  it("plans Open WebUI as a functional-image lane with OpenAI credentials", () => {
    const plan = planFor({
      includeOpenWebUI: true,
      selectedLaneNames: ["openwebui"],
    });

    expect(plan.credentials).toEqual(["openai"]);
    expect(plan.lanes).toEqual([
      expect.objectContaining({
        imageKind: "functional",
        live: false,
        name: "openwebui",
      }),
    ]);
    expect(plan.needs).toMatchObject({
      functionalImage: true,
      package: true,
    });
  });

  it("maps the legacy bundled channel deps lane to the split compat lane", () => {
    const selectedLaneNames = parseLaneSelection("bundled-channel-deps");
    const plan = planFor({ selectedLaneNames });

    expect(selectedLaneNames).toEqual(["bundled-channel-deps-compat"]);
    expect(plan.lanes).toEqual([
      expect.objectContaining({
        imageKind: "bare",
        name: "bundled-channel-deps-compat",
      }),
    ]);
  });

  it("maps installer E2E to provider-specific package install lanes", () => {
    const selectedLaneNames = parseLaneSelection("install-e2e");
    const plan = planFor({ selectedLaneNames });

    expect(selectedLaneNames).toEqual(["install-e2e-openai", "install-e2e-anthropic"]);
    expect(plan.lanes).toEqual([
      expect.objectContaining({
        command: expect.stringContaining("OPENCLAW_E2E_MODELS=openai"),
        name: "install-e2e-openai",
      }),
      expect.objectContaining({
        command: expect.stringContaining("OPENCLAW_E2E_MODELS=anthropic"),
        name: "install-e2e-anthropic",
      }),
    ]);
    expect(plan.credentials).toEqual(["anthropic", "openai"]);
  });

  it("maps bundled plugin install/uninstall to package-backed shards", () => {
    const selectedLaneNames = parseLaneSelection("bundled-plugin-install-uninstall");
    const plan = planFor({ selectedLaneNames });

    expect(selectedLaneNames).toEqual(
      Array.from({ length: 8 }, (_, index) => `bundled-plugin-install-uninstall-${index}`),
    );
    expect(plan.lanes).toHaveLength(8);
    expect(plan.lanes[0]).toEqual(
      expect.objectContaining({
        command: expect.stringContaining("OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX=0"),
        imageKind: "functional",
        live: false,
        name: "bundled-plugin-install-uninstall-0",
        resources: expect.arrayContaining(["docker", "npm"]),
      }),
    );
    expect(plan.lanes[7]).toEqual(
      expect.objectContaining({
        command: expect.stringContaining("OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX=7"),
        imageKind: "functional",
        live: false,
        name: "bundled-plugin-install-uninstall-7",
        resources: expect.arrayContaining(["docker", "npm"]),
      }),
    );
    expect(plan.needs).toMatchObject({
      functionalImage: true,
      package: true,
    });
  });

  it("rejects unknown selected lanes with the available lane names", () => {
    expect(() => planFor({ selectedLaneNames: ["missing-lane"] })).toThrow(
      /OPENCLAW_DOCKER_ALL_LANES unknown lane\(s\): missing-lane/u,
    );
  });
});
