import { describe, expect, it } from "vitest";
import {
  BUNDLED_RUNTIME_SIDECAR_BASENAMES,
  BUNDLED_RUNTIME_SIDECAR_PATHS,
  GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES,
  getPublicArtifactBasename,
} from "./public-artifacts.js";

describe("public artifact manifests", () => {
  it("derives bundled sidecar basenames from the runtime sidecar paths", () => {
    expect(BUNDLED_RUNTIME_SIDECAR_BASENAMES).toEqual([
      ...new Set(BUNDLED_RUNTIME_SIDECAR_PATHS.map(getPublicArtifactBasename)),
    ]);
  });

  it("keeps every bundled sidecar basename in the guarded public surface list", () => {
    const guardedBasenames = new Set(GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES);
    for (const basename of BUNDLED_RUNTIME_SIDECAR_BASENAMES) {
      expect(guardedBasenames.has(basename), basename).toBe(true);
    }
  });
});
