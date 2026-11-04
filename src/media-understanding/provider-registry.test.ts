import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { mediaModels } from "./media-config.test-support.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "./provider-registry.js";

// mock-isolation: Test explicit registry entries without loading installed providers.
vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

const metadata = vi.hoisted(() => vi.fn());
// mock-isolation: Synthetic declarations must not read host plugin ownership.
vi.mock("../plugins/manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot: metadata,
}));
beforeEach(() => metadata.mockReturnValue(createPluginMetadataSnapshotFixture()));

const cfg: OpenClawConfig = { models: mediaModels("acme", "vision", ["text", "image"]) };

describe("media-understanding provider registry", () => {
  it.each([false, true])(
    "keeps literal provider hooks separate regardless of order (%s)",
    (reverse) => {
      metadata.mockReturnValue(
        createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "synthetic-owner",
              providers: ["gemini"],
            },
          ],
        }),
      );
      const google = { id: "google", capabilities: ["video" as const], describeVideo: vi.fn() };
      const gemini = { id: "gemini", describeImage: vi.fn() };
      const registry = buildMediaUnderstandingRegistry(
        undefined,
        {},
        reverse ? [gemini, google] : [google, gemini],
      );
      expect(getMediaUnderstandingProvider(" GEMINI ", registry)).toEqual(gemini);
      expect(getMediaUnderstandingProvider("google", registry)).toEqual(google);
      expect(getMediaUnderstandingProvider("gemini", registry)?.describeVideo).toBeUndefined();
    },
  );

  it.each([true, false])(
    "reserves model-only identities only for enabled owners (%s)",
    (enabled) => {
      metadata.mockReturnValue(
        createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "synthetic-owner",
              providers: ["gemini"],
            },
          ],
        }),
      );
      const google = { id: "google", capabilities: ["video" as const], describeVideo: vi.fn() };
      const registry = buildMediaUnderstandingRegistry(
        { gemini: google },
        {
          plugins: { entries: { "synthetic-owner": { enabled } } },
        },
        [google],
      );
      const selected = getMediaUnderstandingProvider("gemini", registry);
      if (enabled) {
        expect(selected?.id).toBe("gemini");
        expect(selected?.describeVideo).toBeUndefined();
        expect(selected?.capabilities).not.toContain("video");
        expect(
          getMediaUnderstandingProvider(
            "gemini",
            buildMediaUnderstandingRegistry(undefined, { plugins: { enabled: false } }, [google]),
          ),
        ).toEqual(google);
      } else {
        expect(selected).toEqual(google);
      }
    },
  );

  it("preserves historical aliases without a distinct provider owner", () => {
    const google = { id: "google", capabilities: ["image" as const] };
    const registry = buildMediaUnderstandingRegistry({ gemini: google }, {}, [google]);
    expect(getMediaUnderstandingProvider(" GEMINI ", registry)).toEqual(google);
    expect(registry.has("gemini")).toBe(false);
  });

  it("preserves partial native overrides for dispatch", () => {
    const overrideImage = vi.fn(async () => ({ text: "override image" }));
    const registered = { id: "acme", capabilities: ["audio" as const] };
    expect(
      buildMediaUnderstandingRegistry(undefined, cfg, [registered]).get("acme")?.capabilities,
    ).toEqual(["audio"]);
    const registry = buildMediaUnderstandingRegistry(
      {
        acme: { id: "acme", capabilities: ["image"], describeImage: overrideImage },
      },
      cfg,
      [registered],
    );
    expect(getMediaUnderstandingProvider("acme", registry)).toMatchObject({
      capabilities: ["image"],
      describeImage: overrideImage,
    });
    expect(getMediaUnderstandingProvider("acme", registry)?.describeImages).toBeUndefined();
  });

  it("auto-registers media-understanding for config providers with image-capable models (#51392)", () => {
    const imageConfig: OpenClawConfig = {
      models: {
        providers: {
          ...mediaModels("glm", "glm-4.6v", ["text", "image"]).providers,
          ...mediaModels("textOnly", "text-model", ["text"]).providers,
        },
      },
    };
    const registry = buildMediaUnderstandingRegistry(undefined, imageConfig);
    const provider = getMediaUnderstandingProvider("glm", registry);
    expect(provider).toMatchObject({ id: "glm", capabilities: ["image"] });
    expect(provider?.describeImage).toBeUndefined();
    expect(provider?.describeImages).toBeUndefined();
    expect(getMediaUnderstandingProvider("textOnly", registry)).toBeUndefined();
  });
});
