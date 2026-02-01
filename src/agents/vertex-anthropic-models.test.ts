import { describe, expect, it } from "vitest";
import {
  buildVertexAnthropicBaseUrl,
  buildVertexAnthropicProvider,
  getVertexClaudeModels,
  hasGcloudAdc,
  resolveGcpLocation,
  resolveGcpProject,
} from "./vertex-anthropic-models.js";

describe("vertex-anthropic-models", () => {
  describe("resolveGcpProject", () => {
    it("returns GOOGLE_CLOUD_PROJECT when set", () => {
      const env = { GOOGLE_CLOUD_PROJECT: "my-project" };
      expect(resolveGcpProject(env)).toBe("my-project");
    });

    it("returns GCLOUD_PROJECT as fallback", () => {
      const env = { GCLOUD_PROJECT: "fallback-project" };
      expect(resolveGcpProject(env)).toBe("fallback-project");
    });

    it("returns CLOUDSDK_CORE_PROJECT as fallback", () => {
      const env = { CLOUDSDK_CORE_PROJECT: "sdk-project" };
      expect(resolveGcpProject(env)).toBe("sdk-project");
    });

    it("returns undefined when no project env is set", () => {
      expect(resolveGcpProject({})).toBeUndefined();
    });

    it("trims whitespace", () => {
      const env = { GOOGLE_CLOUD_PROJECT: "  spaced-project  " };
      expect(resolveGcpProject(env)).toBe("spaced-project");
    });
  });

  describe("resolveGcpLocation", () => {
    it("returns GOOGLE_CLOUD_LOCATION when set", () => {
      const env = { GOOGLE_CLOUD_LOCATION: "us-east5" };
      expect(resolveGcpLocation(env)).toBe("us-east5");
    });

    it("returns CLOUDSDK_COMPUTE_REGION as fallback", () => {
      const env = { CLOUDSDK_COMPUTE_REGION: "europe-west1" };
      expect(resolveGcpLocation(env)).toBe("europe-west1");
    });

    it("returns undefined when no location env is set", () => {
      expect(resolveGcpLocation({})).toBeUndefined();
    });
  });

  describe("hasGcloudAdc", () => {
    it("returns true when GOOGLE_APPLICATION_CREDENTIALS is set", () => {
      const env = { GOOGLE_APPLICATION_CREDENTIALS: "/path/to/key.json" };
      expect(hasGcloudAdc(env)).toBe(true);
    });

    it("returns false when only GOOGLE_CLOUD_PROJECT is set (not credentials)", () => {
      const env = { GOOGLE_CLOUD_PROJECT: "my-project" };
      expect(hasGcloudAdc(env)).toBe(false);
    });

    it("returns false when only GCLOUD_PROJECT is set (not credentials)", () => {
      const env = { GCLOUD_PROJECT: "my-project" };
      expect(hasGcloudAdc(env)).toBe(false);
    });

    it("returns false when no GCP env is set", () => {
      expect(hasGcloudAdc({})).toBe(false);
    });
  });

  describe("buildVertexAnthropicBaseUrl", () => {
    it("builds correct URL for project and location", () => {
      const url = buildVertexAnthropicBaseUrl("my-project", "us-east5");
      expect(url).toBe(
        "https://us-east5-aiplatform.googleapis.com/v1/projects/my-project/locations/us-east5/publishers/anthropic/models",
      );
    });

    it("handles different regions", () => {
      const url = buildVertexAnthropicBaseUrl("test-proj", "asia-southeast1");
      expect(url).toContain("asia-southeast1-aiplatform.googleapis.com");
      expect(url).toContain("projects/test-proj");
      expect(url).toContain("locations/asia-southeast1");
    });
  });

  describe("buildVertexAnthropicProvider", () => {
    it("returns valid provider config", () => {
      const provider = buildVertexAnthropicProvider({
        project: "my-project",
        location: "us-east5",
      });

      expect(provider.baseUrl).toContain("us-east5-aiplatform.googleapis.com");
      expect(provider.api).toBe("anthropic-messages");
      expect(provider.auth).toBe("token");
      expect(provider.models).toBeDefined();
      expect(provider.models.length).toBeGreaterThan(0);
    });

    it("includes Claude models with correct properties", () => {
      const provider = buildVertexAnthropicProvider({
        project: "test",
        location: "us-east5",
      });

      const opus = provider.models.find((m) => m.id.includes("opus-4-5"));
      expect(opus).toBeDefined();
      expect(opus?.reasoning).toBe(true);
      expect(opus?.input).toContain("text");
      expect(opus?.input).toContain("image");
      expect(opus?.contextWindow).toBe(200000);
    });
  });

  describe("getVertexClaudeModels", () => {
    it("returns array of models", () => {
      const models = getVertexClaudeModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });

    it("includes expected model IDs with version suffix", () => {
      const models = getVertexClaudeModels();
      const ids = models.map((m) => m.id);

      expect(ids.some((id) => id.includes("claude-opus-4-5@"))).toBe(true);
      expect(ids.some((id) => id.includes("claude-sonnet-4@"))).toBe(true);
      expect(ids.some((id) => id.includes("claude-haiku"))).toBe(true);
    });

    it("all models have required fields", () => {
      const models = getVertexClaudeModels();

      for (const model of models) {
        expect(model.id).toBeDefined();
        expect(model.name).toBeDefined();
        expect(typeof model.reasoning).toBe("boolean");
        expect(Array.isArray(model.input)).toBe(true);
        expect(model.contextWindow).toBeGreaterThan(0);
        expect(model.maxTokens).toBeGreaterThan(0);
      }
    });
  });
});
