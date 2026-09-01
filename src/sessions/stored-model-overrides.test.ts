import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveStoredModelOverride } from "./stored-model-overrides.js";

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => ({
    configFingerprint: "stored-model-overrides",
    ...createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "stored-model-normalizer",
          modelIdNormalization: {
            providers: {
              custom: { aliases: { middle: "final", final: "replayed" } },
            },
          },
        },
      ],
    }),
  }),
}));

describe("resolveStoredModelOverride", () => {
  it.each(["session", "parent"] as const)(
    "preserves resolved literal and static identities from %s",
    (source) => {
      for (const model of ["custom/model", "middle"]) {
        const entry: SessionEntry = {
          sessionId: "selected",
          updatedAt: 1,
          providerOverride: "custom",
          modelOverride: model,
          modelOverrideRouteResolution: "resolved",
        };
        expect(
          resolveStoredModelOverride({
            defaultProvider: "custom",
            ...(source === "session"
              ? { sessionEntry: entry }
              : {
                  sessionKey: "child",
                  parentSessionKey: "parent",
                  sessionStore: { parent: entry },
                }),
          }),
        ).toEqual({ provider: "custom", model, source, sourceRouteResolution: "resolved" });
      }
    },
  );

  it("recovers resolved provenance for legacy auto-fallback overrides", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionEntry: {
          sessionId: "legacy-fallback",
          updatedAt: 1,
          providerOverride: "cloudflare-ai-gateway",
          modelOverride: "gemini-2.5-flash-lite",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "anthropic",
          modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
        },
      }),
    ).toMatchObject({ sourceRouteResolution: "resolved" });
  });

  it("loads parent overrides without requiring a whole session store", () => {
    const loadSessionEntry = vi.fn((sessionKey: string) =>
      sessionKey === "agent:main:telegram:dm:parent"
        ? {
            sessionId: "parent-session",
            updatedAt: 1782259200000,
            providerOverride: "anthropic",
            modelOverride: "claude-sonnet-4-7",
          }
        : undefined,
    );

    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        loadSessionEntry,
        sessionKey: "agent:main:telegram:dm:parent:thread:child",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-7",
      source: "parent",
      sourceRouteResolution: "raw",
    });
    expect(loadSessionEntry).toHaveBeenCalledWith("agent:main:telegram:dm:parent");
  });

  it("does not inherit active automatic fallback overrides from parent sessions", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:discord:channel:root:thread:child",
        sessionStore: {
          "agent:main:discord:channel:root": {
            sessionId: "parent-session",
            updatedAt: 1,
            providerOverride: "google-vertex",
            modelOverride: "gemini-fallback",
            modelOverrideSource: "auto",
            modelOverrideFallbackOriginProvider: "openai",
            modelOverrideFallbackOriginModel: "gpt-primary",
          },
        },
      }),
    ).toBeNull();
  });

  it("inherits configured automatic selections without fallback provenance", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:discord:channel:root:thread:child",
        sessionStore: {
          "agent:main:discord:channel:root": {
            sessionId: "legacy-parent-session",
            updatedAt: 1,
            providerOverride: "google-vertex",
            modelOverride: "gemini-fallback",
            modelOverrideSource: "auto",
          },
        },
      }),
    ).toEqual({
      provider: "google-vertex",
      model: "gemini-fallback",
      source: "parent",
      sourceRouteResolution: "raw",
    });
  });

  it("continues to inherit deliberate parent model pins", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:discord:channel:root:thread:child",
        sessionStore: {
          "agent:main:discord:channel:root": {
            sessionId: "parent-session",
            updatedAt: 1,
            providerOverride: "anthropic",
            modelOverride: "claude-sonnet-4-6",
            modelOverrideSource: "user",
          },
        },
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      source: "parent",
      sourceRouteResolution: "raw",
    });
  });
});
