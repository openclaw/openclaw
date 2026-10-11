import { describe, expect, it, type Mock } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeConfiguredModel, makeEntry } from "./model-selection.inputs.test-support.js";
import type { createModelSelectionState } from "./model-selection.js";
import type { persistReplySessionEntry as PersistReplySessionEntry } from "./session-entry-persistence.js";

/** Reuse the owning suite's catalog and persistence fixtures without another test process. */
export function registerRefusedPinSelectionTests({
  selectSession,
  persistReplySessionEntry,
  sessionKey,
}: {
  selectSession: (
    cfg: OpenClawConfig,
    provider: string,
    model: string,
    entry: SessionEntry,
    options?: Partial<Parameters<typeof createModelSelectionState>[0]>,
  ) => ReturnType<typeof createModelSelectionState>;
  persistReplySessionEntry: Mock<typeof PersistReplySessionEntry>;
  sessionKey: string;
}): void {
  describe("refused pins use the primary instead of catalog order", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "provider-b/model-b1",
          modelPolicy: { allow: ["provider-a/model-a1", "provider-b/model-b1"] },
        },
      },
      models: {
        providers: {
          "provider-a": {
            api: "openai-responses",
            baseUrl: "https://provider-a.example/v1",
            models: [makeConfiguredModel({ id: "model-a1", name: "Provider A" })],
          },
          "provider-b": {
            api: "openai-responses",
            baseUrl: "https://provider-b.example/v1",
            models: [makeConfiguredModel({ id: "model-b1", name: "Provider B" })],
          },
        },
      },
    };

    it.each(["direct", "parent", "degraded", "concurrent"] as const)(
      "uses the primary for a refused %s pin",
      async (source) => {
        const pin = makeEntry({
          providerOverride: "provider-c",
          modelOverride: "model-c1",
          modelOverrideSource: "user",
        });
        const entry = source === "parent" ? makeEntry() : { ...pin };
        const parentSessionKey = "agent:main:parent";
        const sessionStore = { [sessionKey]: entry, [parentSessionKey]: pin };
        if (source === "concurrent") {
          persistReplySessionEntry.mockResolvedValueOnce({
            status: "current",
            entry: { ...pin, updatedAt: pin.updatedAt + 1 },
          });
        }
        const state = await selectSession(
          source === "degraded"
            ? {
                ...cfg,
                agents: {
                  defaults: {
                    ...cfg.agents?.defaults,
                    modelPolicy: { allow: ["provider-a/*", "provider-b/model-b1"] },
                  },
                },
              }
            : cfg,
          "provider-b",
          "model-b1",
          entry,
          {
            agentCfg: cfg.agents?.defaults,
            sessionStore,
            parentSessionKey: source === "parent" ? parentSessionKey : undefined,
            provider: "provider-c",
            model: "model-c1",
            ...(source === "concurrent" ? { storePath: "sessions.json" } : {}),
            ...(source === "degraded"
              ? {
                  preparedModelCatalog: {
                    authoritative: false,
                    entries: [
                      { provider: "provider-a", id: "model-a1", name: "First" },
                      { provider: "provider-b", id: "model-b1", name: "Primary" },
                    ],
                    routeVariants: [],
                  },
                }
              : {}),
          },
        );
        expect(state).toMatchObject({
          provider: "provider-b",
          model: "model-b1",
          resetModelOverride: source === "direct",
        });
        expect(state.resetModelOverrideReason).toBe(
          source === "concurrent"
            ? undefined
            : source === "degraded"
              ? "temporarily-unavailable"
              : "disallowed",
        );
        if (source !== "concurrent") {
          expect(state.resetModelOverrideRef).toBe("provider-c/model-c1");
        }
        if (source === "direct" || source === "parent") {
          expect(entry.modelOverride).toBeUndefined();
          expect(entry.providerOverride).toBeUndefined();
        } else {
          expect(entry.modelOverride).toBe("model-c1");
          expect(entry.modelOverrideSource).toBe("user");
        }
        if (source === "parent") {
          expect(sessionStore[parentSessionKey]).toMatchObject({
            providerOverride: "provider-c",
            modelOverride: "model-c1",
            modelOverrideSource: "user",
          });
        }
      },
    );
  });
}
