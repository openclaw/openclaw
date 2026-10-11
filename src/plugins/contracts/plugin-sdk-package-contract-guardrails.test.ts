import { describe, expect, it } from "vitest";
import * as memoryCoreRuntime from "../../plugin-sdk/memory-core-host-runtime-core.js";

describe("plugin-sdk package contract guardrails", () => {
  it("keeps configured local-origin fetch helpers out of the public SSRF runtime", async () => {
    const ssrfRuntime = await import("../../plugin-sdk/ssrf-runtime.js");

    expect(ssrfRuntime).not.toHaveProperty("fetchConfiguredLocalOriginWithSsrFGuard");
  });

  it("keeps memory provenance mutation out of the packaged Memory Core facade", () => {
    expect(memoryCoreRuntime).not.toHaveProperty("recordMemoryArtifactWriteProvenance");
  });
});
