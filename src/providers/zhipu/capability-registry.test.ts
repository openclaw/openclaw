import { describe, expect, it } from "vitest";
import {
  ZHIPU_MODEL_CATALOG,
  getCapability,
  supports,
  endpointFor,
  extractionFor,
  retryPolicyFor,
  getAllModelIds,
  getModelIdsByModality,
  getModelIdsByTier,
  Modality,
  EndpointFamily,
} from "./capability-registry.js";

describe("ZHIPU Capability Registry", () => {
  describe("getCapability", () => {
    it("should return capability for exact model match", () => {
      const capability = getCapability("glm-4.7");
      expect(capability).toBeTruthy();
      expect(capability?.modelId).toBe("glm-4.7");
      expect(capability?.name).toBe("GLM-4.7");
      expect(capability?.supportedModalities).toContain(Modality.TEXT);
    });

    it("should return capability for pattern match", () => {
      const capability = getCapability("viduq1-test-123");
      expect(capability).toBeTruthy();
      expect(capability?.modelId).toBe("viduq1-test-123");
      expect(capability?.name).toBe("Vidu Q1 Pattern");
      expect(capability?.supportedModalities).toContain(Modality.VIDEO_GEN_ASYNC);
    });

    it("should return null for unknown model", () => {
      const capability = getCapability("unknown-model");
      expect(capability).toBeNull();
    });
  });

  describe("supports", () => {
    it("should return true for supported modality", () => {
      expect(supports("glm-4.7", Modality.TEXT)).toBe(true);
    });

    it("should return false for unsupported modality", () => {
      expect(supports("glm-4.7", Modality.IMAGE_GEN)).toBe(false);
    });

    it("should return false for unknown model", () => {
      expect(supports("unknown-model", Modality.TEXT)).toBe(false);
    });
  });

  describe("endpointFor", () => {
    it("should return correct endpoint for text modality", () => {
      const endpoint = endpointFor("glm-4.7", Modality.TEXT);
      expect(endpoint).toBe(EndpointFamily.CHAT_VISION);
    });

    it("should return correct endpoint for vision modality", () => {
      const endpoint = endpointFor("glm-4.6v", Modality.VISION);
      expect(endpoint).toBe(EndpointFamily.CHAT_VISION);
    });

    it("should return null for unsupported modality", () => {
      const endpoint = endpointFor("glm-4.7", Modality.IMAGE_GEN);
      expect(endpoint).toBeNull();
    });

    it("should return null for unknown model", () => {
      const endpoint = endpointFor("unknown-model", Modality.TEXT);
      expect(endpoint).toBeNull();
    });
  });

  describe("extractionFor", () => {
    it("should return extraction rule for text modality", () => {
      const rule = extractionFor("glm-4.7", Modality.TEXT);
      expect(rule).toBeTruthy();
      expect(rule?.fieldPath).toEqual(["choices", 0, "message", "content"]);
      expect(rule?.transform).toBe("first");
    });

    it("should return extraction rule for image generation", () => {
      const rule = extractionFor("glm-image", Modality.IMAGE_GEN);
      expect(rule).toBeTruthy();
      expect(rule?.fieldPath).toEqual(["data", 0, "url"]);
      expect(rule?.transform).toBe("url");
    });

    it("should return null for unsupported modality", () => {
      const rule = extractionFor("glm-4.7", Modality.IMAGE_GEN);
      expect(rule).toBeNull();
    });

    it("should return null for unknown model", () => {
      const rule = extractionFor("unknown-model", Modality.TEXT);
      expect(rule).toBeNull();
    });
  });

  describe("retryPolicyFor", () => {
    it("should return retry policy for chat vision endpoint", () => {
      const policy = retryPolicyFor(EndpointFamily.CHAT_VISION);
      expect(policy).toBeTruthy();
      expect(policy?.maxAttempts).toBe(3);
      expect(policy?.baseDelayMs).toBe(1000);
      expect(policy?.retryableHttpStatuses).toContain(429);
    });

    it("should return retry policy for video poll endpoint", () => {
      const policy = retryPolicyFor(EndpointFamily.VIDEO_POLL);
      expect(policy).toBeTruthy();
      expect(policy?.maxAttempts).toBe(10);
      expect(policy?.defaultTimeoutMs).toBe(120000);
    });

    it("should return null for unknown endpoint", () => {
      const policy = retryPolicyFor("unknown" as EndpointFamily);
      expect(policy).toBeNull();
    });
  });

  describe("getAllModelIds", () => {
    it("should return all model IDs", () => {
      const modelIds = getAllModelIds();
      expect(modelIds).toContain("glm-4.7");
      expect(modelIds).toContain("glm-4.7-flash");
      expect(modelIds).toContain("viduq1-*");
      expect(modelIds.length).toBeGreaterThan(10);
    });
  });

  describe("getModelIdsByModality", () => {
    it("should return model IDs for text modality", () => {
      const modelIds = getModelIdsByModality(Modality.TEXT);
      expect(modelIds).toContain("glm-4.7");
      expect(modelIds).toContain("glm-4.7-flash");
      expect(modelIds).not.toContain("glm-image");
    });

    it("should return model IDs for image generation modality", () => {
      const modelIds = getModelIdsByModality(Modality.IMAGE_GEN);
      expect(modelIds).toContain("glm-image");
      expect(modelIds).toContain("cogview-3-flash");
      expect(modelIds).not.toContain("glm-4.7");
    });

    it("should return empty array for unknown modality", () => {
      const modelIds = getModelIdsByModality("unknown" as Modality);
      expect(modelIds).toEqual([]);
    });
  });

  describe("getModelIdsByTier", () => {
    it("should return pro model IDs", () => {
      const modelIds = getModelIdsByTier("pro");
      expect(modelIds).toContain("glm-4.7");
      expect(modelIds).toContain("glm-image");
      expect(modelIds).not.toContain("glm-4.7-flash");
    });

    it("should return free model IDs", () => {
      const modelIds = getModelIdsByTier("free");
      expect(modelIds).toContain("glm-4.7-flash");
      expect(modelIds).toContain("cogview-3-flash");
      expect(modelIds).not.toContain("glm-4.7");
    });
  });

  describe("ZHIPU_MODEL_CATALOG", () => {
    it("should contain all expected models", () => {
      const glm4Capability = ZHIPU_MODEL_CATALOG.find((cap) => cap.modelId === "glm-4.7");
      expect(glm4Capability).toBeTruthy();
      expect(glm4Capability?.name).toBe("GLM-4.7");
      expect(glm4Capability?.notes).toContain("Pro team model");

      const flashCapability = ZHIPU_MODEL_CATALOG.find((cap) => cap.modelId === "glm-4.7-flash");
      expect(flashCapability).toBeTruthy();
      expect(flashCapability?.name).toBe("GLM-4.7 Flash");
      expect(flashCapability?.flags).toContain("free_tier");

      const viduq1Capability = ZHIPU_MODEL_CATALOG.find((cap) => cap.modelId === "viduq1-*");
      expect(viduq1Capability).toBeTruthy();
      expect(viduq1Capability?.notes).toContain("Pattern match for viduq1-* video models");
    });

    it("should have correct endpoint mappings", () => {
      const capability = getCapability("glm-4.6v");
      expect(capability?.endpointFamilyByModality[Modality.TEXT]).toBe(EndpointFamily.CHAT_VISION);
      expect(capability?.endpointFamilyByModality[Modality.VISION]).toBe(
        EndpointFamily.CHAT_VISION,
      );
      expect(capability?.endpointFamilyByModality[Modality.OCR]).toBe(EndpointFamily.OCR);
    });
  });
});
