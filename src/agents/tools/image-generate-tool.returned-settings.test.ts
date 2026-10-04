import { describe, expect, it } from "vitest";
import { buildReturnedImageSettingsDetails } from "./image-generate-tool.returned-settings.js";

describe("buildReturnedImageSettingsDetails", () => {
  it("reports applied settings separately from requested settings", () => {
    expect(
      buildReturnedImageSettingsDetails({
        images: [{ metadata: { size: "941x1672", quality: "medium" } }],
        paths: ["/tmp/generated.png"],
        requestedSize: "2160x3840",
        requestedQuality: "high",
      }),
    ).toEqual({
      size: "941x1672",
      requestedSize: "2160x3840",
      quality: "medium",
      requestedQuality: "high",
      imageSettings: [{ path: "/tmp/generated.png", size: "941x1672", quality: "medium" }],
    });
  });

  it("keeps heterogeneous applied settings per output", () => {
    expect(
      buildReturnedImageSettingsDetails({
        images: [
          { metadata: { size: "941x1672", quality: "medium" } },
          { metadata: { size: "1024x1536", quality: "low" } },
        ],
        paths: ["/tmp/generated-1.png", "/tmp/generated-2.png"],
        requestedSize: "2160x3840",
        requestedQuality: "high",
      }),
    ).toEqual({
      requestedSize: "2160x3840",
      requestedQuality: "high",
      imageSettings: [
        { path: "/tmp/generated-1.png", size: "941x1672", quality: "medium" },
        { path: "/tmp/generated-2.png", size: "1024x1536", quality: "low" },
      ],
    });
  });

  it("measures auto or malformed sizes and does not report unknown quality as applied", () => {
    expect(
      buildReturnedImageSettingsDetails({
        images: [
          { metadata: { size: "auto", quality: "auto" } },
          { metadata: { size: "not-a-size", quality: "unknown" } },
        ],
        paths: ["/tmp/generated-1.png", "/tmp/generated-2.png"],
        observedSizes: ["1024x1536", "1024x1536"],
        requestedSize: "2160x3840",
        requestedQuality: "high",
      }),
    ).toEqual({
      size: "1024x1536",
      requestedSize: "2160x3840",
      requestedQuality: "high",
      imageSettings: [
        { path: "/tmp/generated-1.png", size: "1024x1536", quality: undefined },
        { path: "/tmp/generated-2.png", size: "1024x1536", quality: undefined },
      ],
    });
  });

  it("does not present requested values as applied when returned metadata is partial", () => {
    expect(
      buildReturnedImageSettingsDetails({
        images: [{ metadata: { size: "1024x1536" } }],
        paths: ["/tmp/generated.png"],
        requestedSize: "2160x3840",
        requestedQuality: "high",
      }),
    ).toEqual({
      size: "1024x1536",
      requestedSize: "2160x3840",
      requestedQuality: "high",
      imageSettings: [{ path: "/tmp/generated.png", size: "1024x1536", quality: undefined }],
    });

    expect(
      buildReturnedImageSettingsDetails({
        images: [{ metadata: { quality: "low" } }],
        paths: ["/tmp/generated.png"],
        requestedSize: "2160x3840",
        requestedQuality: "high",
        fallbackSize: "2160x3840",
        observedSizes: ["1024x1536"],
      }),
    ).toEqual({
      size: "1024x1536",
      requestedSize: "2160x3840",
      quality: "low",
      requestedQuality: "high",
      imageSettings: [{ path: "/tmp/generated.png", size: "1024x1536", quality: "low" }],
    });
  });
});
