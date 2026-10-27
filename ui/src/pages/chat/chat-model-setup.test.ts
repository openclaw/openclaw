import { expect, it } from "vitest";
import { createActiveSessionPlacement } from "../../test-helpers/session-placement.ts";
import { resolveChatModelSetup, requiresChatModelSetup } from "./chat-model-setup.ts";

type ModelSetup = Parameters<typeof resolveChatModelSetup>[0];

const loaded = {
  catalog: false,
  connected: true,
  agentsLoaded: true,
  selectedAgentFound: true,
};

it.each([
  ["missing model route", {}, true],
  ["configured model", { agentModel: "openai/gpt-5.4" }, false],
  ["unresolved agent", { agentsLoaded: false, selectedAgentFound: false }, false],
] as const)("requiresChatModelSetup: %s", (_name, overrides, required) => {
  expect(requiresChatModelSetup({ ...loaded, ...overrides })).toBe(required);
});

const active = createActiveSessionPlacement({
  environmentId: "worker:test",
  workspaceBaseManifestRef: "workspace-base",
  remoteWorkspaceDir: "/worker/workspace",
  inference: "worker" as const,
});

it.each(["missing-auth", "auth-failed"] as const)(
  "ignores only Gateway provider credentials for a current worker placement (%s)",
  (unavailableReason) => {
    const catalog = [
      {
        id: "gpt-4.1-mini",
        name: "GPT-4.1 mini",
        provider: "openai",
        available: false,
        unavailableReason,
      },
    ];
    const session = {
      key: "agent:main:worker-test",
      kind: "direct" as const,
      updatedAt: 1,
      model: "gpt-4.1-mini",
      modelProvider: "openai",
    };
    const banner = (
      placement?: NonNullable<ModelSetup["activeSession"]>["placement"],
      overrides: Partial<ModelSetup> = {},
    ) =>
      resolveChatModelSetup({
        ...loaded,
        agentModel: "openai/gpt-4.1-mini",
        chatModelCatalog: catalog,
        modelOverrides: {},
        sessionKey: "agent:main:worker-test",
        sessionsResult: null,
        catalogError: null,
        onSetup: () => undefined,
        activeSession: { ...session, placement },
        ...overrides,
      }).modelUnavailableBanner;
    expect(banner()).toBeDefined();
    expect(banner(active)).toBeUndefined();
    expect(
      banner(active, {
        activeSession: {
          ...session,
          modelOverrideSource: "user",
          placement: active,
        },
      }),
    ).toBeUndefined();
    expect(banner(active, { catalogRetired: true })).toBeDefined();
    expect(
      banner(active, {
        modelSelectionPolicy: { restricted: true, defaultModel: null },
        chatModelCatalog: [],
      }),
    ).toBeDefined();
    expect(banner({ ...active, state: "reclaimed" })).toBeDefined();
    expect(banner({ ...active, state: "local" })).toBeDefined();
    const { inference: _inference, ...proxied } = active;
    expect(banner(proxied)).toBeDefined();
  },
);

it.each([
  ["claude-cli", undefined],
  ["openclaw", "No provider credential"],
  [undefined, "No provider credential"],
] as const)(
  "uses the session's selected runtime for the credential banner (runtime=%s)",
  (agentRuntime, expected) => {
    // The base API route lacks an OpenClaw credential; the native Claude CLI route is ready.
    const entry = {
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      provider: "anthropic",
      available: false,
      unavailableReason: "missing-auth" as const,
      agentRuntime: { id: "openclaw", source: "model" as const },
      runtimeChoices: [
        { agentRuntime: { id: "claude-cli", source: "model" as const }, available: true },
      ],
    };
    const banner = resolveChatModelSetup({
      ...loaded,
      agentModel: "anthropic/claude-opus-5-5",
      chatModelCatalog: [entry],
      modelOverrides: {},
      sessionKey: "agent:main:main",
      sessionsResult: null,
      catalogError: null,
      onSetup: () => undefined,
      activeSession: {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 1,
        model: "claude-opus-5-5",
        modelProvider: "anthropic",
        ...(agentRuntime ? { agentRuntime: { id: agentRuntime, source: "session" as const } } : {}),
      },
    }).modelUnavailableBanner;
    expect(banner?.text).toEqual(expected ? expect.stringContaining(expected) : undefined);
  },
);
