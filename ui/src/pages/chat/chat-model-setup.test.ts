import { describe, expect, it } from "vitest";
import { resolveChatModelSetup, requiresChatModelSetup } from "./chat-model-setup.ts";

describe("requiresChatModelSetup", () => {
  it("requires setup after the selected agent loads without a model route", () => {
    expect(
      requiresChatModelSetup({
        catalog: false,
        connected: true,
        agentsLoaded: true,
        selectedAgentFound: true,
      }),
    ).toBe(true);
  });

  it("accepts a configured agent model", () => {
    expect(
      requiresChatModelSetup({
        catalog: false,
        connected: true,
        agentsLoaded: true,
        selectedAgentFound: true,
        agentModel: "openai/gpt-5.4",
      }),
    ).toBe(false);
  });

  it("does not block while connection or agent data is unresolved", () => {
    expect(
      requiresChatModelSetup({
        catalog: false,
        connected: true,
        agentsLoaded: false,
        selectedAgentFound: false,
      }),
    ).toBe(false);
  });
});

describe("worker inference credential banner", () => {
  const active = {
    state: "active" as const,
    generation: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
    environmentId: "worker:test",
    activeOwnerEpoch: 1,
    workerBundleHash: "a".repeat(64),
    workspaceBaseManifestRef: "workspace-base",
    remoteWorkspaceDir: "/worker/workspace",
    inference: "worker" as const,
  };

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
      const banner = (
        placement?:
          | (Omit<typeof active, "inference"> & { inference?: "worker" })
          | (Omit<typeof active, "state"> & { state: "reclaimed" | "local" }),
        overrides: Partial<Parameters<typeof resolveChatModelSetup>[0]> = {},
      ) =>
        resolveChatModelSetup({
          catalog: false,
          connected: true,
          agentsLoaded: true,
          selectedAgentFound: true,
          agentModel: "openai/gpt-4.1-mini",
          chatModelCatalog: catalog,
          modelOverrides: {},
          sessionKey: "agent:main:worker-test",
          sessionsResult: null,
          catalogError: null,
          onSetup: () => undefined,
          activeSession: {
            key: "agent:main:worker-test",
            kind: "direct",
            updatedAt: 1,
            model: "gpt-4.1-mini",
            modelProvider: "openai",
            placement,
          },
          ...overrides,
        }).modelUnavailableBanner;
      expect(banner()).toBeDefined();
      expect(banner(active)).toBeUndefined();
      // Selection validation has already committed this model. Its current
      // worker binding, not later Gateway credential loss, owns turn auth.
      expect(
        banner(active, {
          activeSession: {
            key: "agent:main:worker-test",
            kind: "direct",
            updatedAt: 1,
            model: "gpt-4.1-mini",
            modelProvider: "openai",
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
});
