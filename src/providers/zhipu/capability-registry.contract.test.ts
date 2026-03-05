import { describe, expect, it } from "vitest";
import { extractionFor, supports, Modality } from "./capability-registry.js";

describe("ZHIPU Capability Registry - Contract Tests", () => {
  // Load fixtures for testing
  const loadFixture = (filename: string): unknown => {
    const fs = require("fs");
    const path = require("path");
    return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", filename), "utf8"));
  };

  describe("TEXT modality", () => {
    const modelId = "glm-4.7";
    const modality = Modality.TEXT;
    const fixture = loadFixture("chat-with-content.json");

    it("should extract content from primary field path", () => {
      const rule = extractionFor(modelId, modality);
      expect(rule).toBeDefined();
      expect(rule?.fieldPath).toEqual(["choices", 0, "message", "content"]);
      expect(rule?.transform).toBe("first");

      // Test extraction logic
      let result: unknown = fixture;
      for (const key of rule!.fieldPath) {
        result = (result as Record<string | number, unknown>)[key];
      }
      expect(result).toBe("hello");
    });

    it("should fall back to reasoning_content when content is empty", () => {
      const fallbackFixture = loadFixture("chat-with-reasoning-only.json");
      const rule = extractionFor(modelId, modality);
      expect(rule?.fallbackFieldPath).toEqual(["choices", 0, "message", "reasoning_content"]);

      // Test primary path extraction
      let result: unknown = fallbackFixture;
      for (const key of rule!.fieldPath) {
        result = (result as Record<string | number, unknown>)[key];
      }
      expect(result).toBe("");

      // Test fallback path extraction
      result = fallbackFixture;
      for (const key of rule!.fallbackFieldPath!) {
        result = (result as Record<string | number, unknown>)[key];
      }
      expect(result).toBe("reasoning text");
    });
  });

  describe("VISION modality", () => {
    const modelId = "glm-4.6v";
    const modality = Modality.VISION;
    const fixture = loadFixture("chat-with-content.json");

    it("should extract content from primary field path", () => {
      const rule = extractionFor(modelId, modality);
      expect(rule).toBeDefined();
      expect(rule?.fieldPath).toEqual(["choices", 0, "message", "content"]);
      expect(rule?.transform).toBe("first");

      // Test extraction logic
      let result: unknown = fixture;
      for (const key of rule!.fieldPath) {
        result = (result as Record<string | number, unknown>)[key];
      }
      expect(result).toBe("hello");
    });

    it("should fall back to reasoning_content when content is empty", () => {
      const fallbackFixture = loadFixture("chat-with-reasoning-only.json");
      const rule = extractionFor(modelId, modality);
      expect(rule?.fallbackFieldPath).toEqual(["choices", 0, "message", "reasoning_content"]);

      // Test fallback path extraction
      let result: unknown = fallbackFixture;
      for (const key of rule!.fallbackFieldPath!) {
        result = (result as Record<string | number, unknown>)[key];
      }
      expect(result).toBe("reasoning text");
    });
  });

  describe("OCR modality", () => {
    const modelId = "glm-ocr";
    const modality = Modality.OCR;
    const fixture = loadFixture("ocr-response.json");

    it("should extract text from results array", () => {
      const rule = extractionFor(modelId, modality);
      expect(rule).toBeDefined();
      expect(rule?.fieldPath).toEqual(["results", 0, "text"]);
      expect(rule?.transform).toBe("first");

      // Test extraction logic
      let result: unknown = fixture;
      for (const key of rule!.fieldPath) {
        result = (result as Record<string | number, unknown>)[key];
      }
      expect(result).toBe("extracted text");
    });
  });

  describe("IMAGE_GEN modality", () => {
    const modelId = "glm-image";
    const modality = Modality.IMAGE_GEN;
    const fixture = loadFixture("image-generation.json");

    it("should extract URL from data array", () => {
      const rule = extractionFor(modelId, modality);
      expect(rule).toBeDefined();
      expect(rule?.fieldPath).toEqual(["data", 0, "url"]);
      expect(rule?.transform).toBe("url");

      // Test extraction logic
      let result: unknown = fixture;
      for (const key of rule!.fieldPath) {
        result = (result as Record<string | number, unknown>)[key];
      }
      expect(result).toBe("https://example.com/generated-image.jpg");
    });
  });

  describe("VIDEO_GEN_ASYNC modality", () => {
    const modelId = "cogvideox-3";
    const modality = Modality.VIDEO_GEN_ASYNC;
    const fixture = loadFixture("video-generation-submit.json");

    it("should extract task_id from root", () => {
      const rule = extractionFor(modelId, modality);
      expect(rule).toBeDefined();
      expect(rule?.fieldPath).toEqual(["task_id"]);
      expect(rule?.transform).toBe("first");

      // Test extraction logic
      let result: unknown = fixture;
      for (const key of rule!.fieldPath) {
        result = (result as Record<string | number, unknown>)[key];
      }
      expect(result).toBe("video_task_123456789");
    });
  });

  describe("VIDEO_POLL modality", () => {
    const modelId = "cogvideox-3";
    const modality = Modality.VIDEO_POLL;
    const successFixture = loadFixture("video-generation-poll-success.json");
    const coverOnlyFixture = loadFixture("video-generation-poll-cover-only.json");

    it("should extract video URL from video_result array", () => {
      const rule = extractionFor(modelId, modality);
      expect(rule).toBeDefined();
      expect(rule?.fieldPath).toEqual(["video_result", 0, "url"]);
      expect(rule?.fallbackFieldPath).toEqual(["cover_image_url"]);
      expect(rule?.transform).toBe("freeze");

      // Test primary path extraction
      let result: unknown = successFixture;
      for (const key of rule!.fieldPath) {
        result = (result as Record<string | number, unknown>)[key];
      }
      expect(result).toBe("https://example.com/generated-video.mp4");
    });

    it("should fall back to cover_image_url when video_result is not available", () => {
      const rule = extractionFor(modelId, modality);
      expect(rule?.fallbackFieldPath).toEqual(["cover_image_url"]);

      // Test fallback path extraction
      let result: unknown = coverOnlyFixture;
      for (const key of rule!.fallbackFieldPath!) {
        result = (result as Record<string | number, unknown>)[key];
      }
      expect(result).toBe("https://example.com/cover-only.jpg");
    });
  });

  describe("AUDIO_TTS modality", () => {
    const modelId = "glm-tts";
    const modality = Modality.AUDIO_TTS;
    const fixture = loadFixture("audio-tts.json");

    it("should extract URL from data array", () => {
      const rule = extractionFor(modelId, modality);
      expect(rule).toBeDefined();
      expect(rule?.fieldPath).toEqual(["data", 0, "url"]);
      expect(rule?.transform).toBe("url");

      // Test extraction logic
      let result: unknown = fixture;
      for (const key of rule!.fieldPath) {
        result = (result as Record<string | number, unknown>)[key];
      }
      expect(result).toBe("https://example.com/speech.mp3");
    });
  });

  describe("Edge Cases", () => {
    it("should handle missing intermediate fields gracefully", () => {
      const rule = extractionFor("glm-4.7", Modality.TEXT);
      const incompleteFixture = { choices: [] }; // Missing message and content

      // Should not throw, but return undefined
      let result: unknown = incompleteFixture;
      try {
        for (const key of rule!.fieldPath) {
          result = (result as Record<string | number, unknown>)[key];
        }
      } catch {
        result = undefined;
      }
      expect(result).toBeUndefined();
    });

    it("should handle empty arrays gracefully", () => {
      const rule = extractionFor("glm-image", Modality.IMAGE_GEN);
      const emptyFixture = { data: [] };

      // Should not throw, but return undefined
      let result: unknown = emptyFixture;
      try {
        for (const key of rule!.fieldPath) {
          result = (result as Record<string | number, unknown>)[key];
        }
      } catch {
        result = undefined;
      }
      expect(result).toBeUndefined();
    });
  });

  describe("Model Support Verification", () => {
    it("should verify TEXT modality support for text models", () => {
      expect(supports("glm-4.7", Modality.TEXT)).toBe(true);
      expect(supports("glm-4.7-flash", Modality.TEXT)).toBe(true);
    });

    it("should verify VISION modality support for vision models", () => {
      expect(supports("glm-4.6v", Modality.VISION)).toBe(true);
      expect(supports("glm-4.6v-flash", Modality.VISION)).toBe(true);
    });

    it("should verify IMAGE_GEN modality support for image models", () => {
      expect(supports("glm-image", Modality.IMAGE_GEN)).toBe(true);
      expect(supports("cogview-3-flash", Modality.IMAGE_GEN)).toBe(true);
    });

    it("should verify VIDEO_GEN_ASYNC modality support for video models", () => {
      expect(supports("cogvideox-3", Modality.VIDEO_GEN_ASYNC)).toBe(true);
      expect(supports("viduq1-test-123", Modality.VIDEO_GEN_ASYNC)).toBe(true);
    });

    it("should verify VIDEO_POLL modality support for video models", () => {
      expect(supports("cogvideox-3", Modality.VIDEO_POLL)).toBe(true);
      expect(supports("viduq1-test-123", Modality.VIDEO_POLL)).toBe(true);
    });

    it("should verify OCR modality support", () => {
      expect(supports("glm-4.7", Modality.OCR)).toBe(false);
      expect(supports("glm-ocr", Modality.OCR)).toBe(true);
    });

    it("should verify AUDIO_TTS modality support", () => {
      expect(supports("glm-4.7", Modality.AUDIO_TTS)).toBe(false);
      expect(supports("glm-tts", Modality.AUDIO_TTS)).toBe(true);
    });
  });
});
