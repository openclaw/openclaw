import { describe, expect, it, vi } from "vitest";

vi.mock("../runtime-backend-catalog.js", () => ({
  listExtensionHostMediaRuntimeBackendCatalogEntries: vi.fn(() => [
    {
      id: "capability.runtime-backend:media.audio:deepgram",
      family: "capability.runtime-backend",
      subsystemId: "media.audio",
      backendId: "deepgram",
      source: "builtin",
      defaultRank: 0,
      selectorKeys: ["deepgram"],
      capabilities: ["audio"],
      metadata: { autoSelectable: true },
    },
    {
      id: "capability.runtime-backend:media.audio:openai",
      family: "capability.runtime-backend",
      subsystemId: "media.audio",
      backendId: "openai",
      source: "builtin",
      defaultRank: 1,
      selectorKeys: ["openai"],
      capabilities: ["audio"],
      metadata: { autoSelectable: true },
    },
    {
      id: "capability.runtime-backend:media.image:openai",
      family: "capability.runtime-backend",
      subsystemId: "media.image",
      backendId: "openai",
      source: "builtin",
      defaultRank: 0,
      selectorKeys: ["openai"],
      capabilities: ["image"],
      metadata: { autoSelectable: true, defaultModel: "openai-default" },
    },
    {
      id: "capability.runtime-backend:media.image:google",
      family: "capability.runtime-backend",
      subsystemId: "media.image",
      backendId: "google",
      source: "builtin",
      defaultRank: 1,
      selectorKeys: ["google", "gemini"],
      capabilities: ["image"],
      metadata: { autoSelectable: true, defaultModel: "google-default" },
    },
    {
      id: "capability.runtime-backend:media.video:openai",
      family: "capability.runtime-backend",
      subsystemId: "media.video",
      backendId: "openai",
      source: "builtin",
      defaultRank: 0,
      selectorKeys: ["openai"],
      capabilities: ["video"],
      metadata: { autoSelectable: true },
    },
  ]),
  listExtensionHostMediaAutoRuntimeBackendIds: vi.fn(
    (capability: "audio" | "image" | "video") =>
      ({
        audio: ["deepgram", "openai"],
        image: ["openai", "google"],
        video: ["openai"],
      })[capability],
  ),
  resolveExtensionHostMediaRuntimeDefaultModel: vi.fn(
    (params: { capability: "audio" | "image" | "video"; backendId: string }) =>
      params.capability === "image" ? `${params.backendId}-default` : undefined,
  ),
}));

vi.mock("../media-runtime-registry.js", () => ({
  normalizeExtensionHostMediaProviderId: vi.fn((id: string) =>
    id.trim().toLowerCase() === "gemini" ? "google" : id.trim().toLowerCase(),
  ),
}));

import { resolveExtensionHostMediaProviderCandidates } from "./media-runtime-policy.js";

describe("media-runtime-policy", () => {
  it("puts the active provider first and keeps the configured model", () => {
    expect(
      resolveExtensionHostMediaProviderCandidates({
        capability: "image",
        activeModel: {
          provider: "Google",
          model: "gemini-2.5-flash",
        },
      }),
    ).toEqual([
      { provider: "google", model: "gemini-2.5-flash" },
      { provider: "openai", model: "openai-default" },
    ]);
  });

  it("uses catalog-backed defaults for fallback image providers", () => {
    expect(
      resolveExtensionHostMediaProviderCandidates({
        capability: "image",
        activeModel: {
          provider: "missing-provider",
          model: "ignored",
        },
      }),
    ).toEqual([
      { provider: "missing-provider", model: "ignored" },
      { provider: "openai", model: "openai-default" },
      { provider: "google", model: "google-default" },
    ]);
  });

  it("keeps non-image fallback candidates model-free", () => {
    expect(
      resolveExtensionHostMediaProviderCandidates({
        capability: "audio",
        activeModel: {
          provider: "openai",
          model: "gpt-4o-mini-transcribe",
        },
      }),
    ).toEqual([
      { provider: "openai", model: "gpt-4o-mini-transcribe" },
      { provider: "deepgram", model: undefined },
    ]);
  });
});
