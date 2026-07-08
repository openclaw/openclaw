// Auth-profile plumbing tests for gateway-scoped tool resolution.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const createOpenClawToolsMock = vi.hoisted(() =>
  vi.fn((_options: { authProfileStore?: AuthProfileStore }) => []),
);

vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: createOpenClawToolsMock,
}));

vi.mock("../agents/agent-tools.policy.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/agent-tools.policy.js")>(
    "../agents/agent-tools.policy.js",
  );
  return {
    ...actual,
    resolveEffectiveToolPolicy: () => ({
      agentId: undefined,
      globalPolicy: undefined,
      globalProviderPolicy: undefined,
      agentPolicy: undefined,
      agentProviderPolicy: undefined,
      profile: undefined,
      providerProfile: undefined,
      profileAlsoAllow: undefined,
      providerProfileAlsoAllow: undefined,
    }),
    resolveGroupToolPolicy: () => undefined,
    resolveInheritedToolPolicyForSession: () => undefined,
    resolveSubagentToolPolicyForSession: () => undefined,
  };
});

vi.mock("../agents/subagent-capabilities.js", () => ({
  isSubagentEnvelopeSession: () => false,
  resolveSubagentCapabilityStore: () => undefined,
}));

vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: () => undefined,
}));

vi.mock("../agents/tool-policy-pipeline.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/tool-policy-pipeline.js")>(
    "../agents/tool-policy-pipeline.js",
  );
  return {
    ...actual,
    applyToolPolicyPipeline: ({ tools }: { tools: unknown[] }) => tools,
  };
});

import { resolveGatewayScopedTools } from "./tool-resolution.js";

function createAuthProfileStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "xai-oauth": {
        provider: "xai",
        type: "oauth",
        access: "xai-access-token",
        refresh: "xai-refresh-token",
        expires: 1_900_000_000_000,
      },
    },
  };
}

describe("resolveGatewayScopedTools auth profile plumbing", () => {
  beforeEach(() => {
    createOpenClawToolsMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards authProfileStore to createOpenClawTools on loopback surfaces", () => {
    const authProfileStore = createAuthProfileStore();
    resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      surface: "loopback",
      authProfileStore,
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const passedOptions = createOpenClawToolsMock.mock.calls[0]?.[0];
    expect(passedOptions).toMatchObject({ authProfileStore });
  });

  it("forwards authProfileStore to createOpenClawTools on http surfaces", () => {
    const authProfileStore = createAuthProfileStore();
    resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      surface: "http",
      authProfileStore,
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const passedOptions = createOpenClawToolsMock.mock.calls[0]?.[0];
    expect(passedOptions).toMatchObject({ authProfileStore });
  });

  it("omits authProfileStore from createOpenClawTools when not provided", () => {
    resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      surface: "loopback",
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const passedOptions = createOpenClawToolsMock.mock.calls[0]?.[0];
    expect(passedOptions.authProfileStore).toBeUndefined();
  });
});
