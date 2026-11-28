import { describe, expect, it } from "vitest";
import { resolveLocalProviderAuthEvidence } from "./provider-auth-evidence.js";
import type { ProviderAuthEvidence } from "./provider-env-vars.js";

const GCE_EVIDENCE: readonly ProviderAuthEvidence[] = [
  {
    type: "gce-metadata-with-env",
    blockedByEnv: ["GOOGLE_APPLICATION_CREDENTIALS"],
    requiresAnyEnv: ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"],
    requiresAllEnv: ["GOOGLE_CLOUD_LOCATION"],
    credentialMarker: "gcp-vertex-credentials",
    source: "gce metadata",
  },
];

describe("resolveLocalProviderAuthEvidence", () => {
  it("resolves gce-metadata-with-env when project, location, and GCE metadata env are present", () => {
    expect(
      resolveLocalProviderAuthEvidence(GCE_EVIDENCE, {
        GOOGLE_CLOUD_PROJECT: "my-project",
        GOOGLE_CLOUD_LOCATION: "global",
        GCE_METADATA_HOST: "metadata.google.internal",
      }),
    ).toEqual({
      credentialMarker: "gcp-vertex-credentials",
      source: "gce metadata",
    });
  });

  it("blocks gce-metadata-with-env when blockedByEnv is set", () => {
    expect(
      resolveLocalProviderAuthEvidence(GCE_EVIDENCE, {
        GOOGLE_CLOUD_PROJECT: "my-project",
        GOOGLE_CLOUD_LOCATION: "global",
        GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent/adc.json",
        GCE_METADATA_HOST: "metadata.google.internal",
      }),
    ).toBeNull();
  });

  it("requires project and location env for gce-metadata-with-env", () => {
    expect(
      resolveLocalProviderAuthEvidence(GCE_EVIDENCE, {
        GOOGLE_CLOUD_PROJECT: "my-project",
        GCE_METADATA_HOST: "metadata.google.internal",
      }),
    ).toBeNull();
  });
});
