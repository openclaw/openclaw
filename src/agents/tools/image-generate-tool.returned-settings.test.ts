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
});
