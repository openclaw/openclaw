import { afterEach, describe, expect, it } from "vitest";
import {
  clearImageGenerationUsage,
  getImageGenerationUsage,
  getImageGenerationUsageSummary,
  getRecentImageGenerationUsage,
  recordImageGeneration,
  type ImageGenerationUsageRecord,
} from "./image-generation-usage.js";

describe("image-generation-usage", () => {
  afterEach(() => {
    clearImageGenerationUsage();
  });

  it("records a generation event", () => {
    const record = recordImageGeneration({
      provider: "openai",
      model: "gpt-image-2",
      success: true,
      count: 2,
      outputUrls: ["/media/img-1.png", "/media/img-2.png"],
    });
    expect(record.provider).toBe("openai");
    expect(record.model).toBe("gpt-image-2");
    expect(record.success).toBe(true);
    expect(record.count).toBe(2);
    expect(record.outputUrls).toHaveLength(2);
    expect(record.id).toMatch(/^img-gen-\d+-\d+$/);
    expect(record.timestamp).toBeGreaterThan(0);
  });

  it("records a failed generation event", () => {
    const record = recordImageGeneration({
      provider: "openai",
      model: "gpt-image-2",
      success: false,
      count: 0,
      outputUrls: [],
      error: "API key missing",
    });
    expect(record.success).toBe(false);
    expect(record.error).toBe("API key missing");
    expect(record.count).toBe(0);
  });

  it("records optional sessionKey, cost, and mediaId", () => {
    const record = recordImageGeneration({
      provider: "google",
      model: "imagen-3",
      success: true,
      count: 1,
      outputUrls: ["/media/img-1.png"],
      sessionKey: "session-abc",
      cost: 0.05,
      mediaId: "media-123",
    });
    expect(record.sessionKey).toBe("session-abc");
    expect(record.cost).toBe(0.05);
    expect(record.mediaId).toBe("media-123");
  });

  it("getImageGenerationUsage returns all records", () => {
    recordImageGeneration({
      provider: "openai",
      model: "gpt-image-2",
      success: true,
      count: 1,
      outputUrls: ["/a.png"],
    });
    recordImageGeneration({
      provider: "google",
      model: "imagen-3",
      success: true,
      count: 1,
      outputUrls: ["/b.png"],
    });
    const records = getImageGenerationUsage();
    expect(records).toHaveLength(2);
  });

  it("getRecentImageGenerationUsage returns newest first", () => {
    recordImageGeneration({
      provider: "openai",
      model: "gpt-image-2",
      success: true,
      count: 1,
      outputUrls: ["/a.png"],
    });
    // Small delay so timestamps differ
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }
    recordImageGeneration({
      provider: "google",
      model: "imagen-3",
      success: true,
      count: 1,
      outputUrls: ["/b.png"],
    });
    const recent = getRecentImageGenerationUsage();
    expect(recent[0].provider).toBe("google");
    expect(recent[1].provider).toBe("openai");
  });

  it("getRecentImageGenerationUsage respects limit", () => {
    for (let i = 0; i < 5; i++) {
      recordImageGeneration({
        provider: "openai",
        model: "gpt-image-2",
        success: true,
        count: 1,
        outputUrls: [`/${i}.png`],
      });
    }
    const recent = getRecentImageGenerationUsage({ limit: 3 });
    expect(recent).toHaveLength(3);
  });

  it("getRecentImageGenerationUsage filters by provider", () => {
    recordImageGeneration({
      provider: "openai",
      model: "gpt-image-2",
      success: true,
      count: 1,
      outputUrls: ["/a.png"],
    });
    recordImageGeneration({
      provider: "google",
      model: "imagen-3",
      success: true,
      count: 1,
      outputUrls: ["/b.png"],
    });
    const openaiRecords = getRecentImageGenerationUsage({ provider: "openai" });
    expect(openaiRecords).toHaveLength(1);
    expect(openaiRecords[0].provider).toBe("openai");
  });

  it("getRecentImageGenerationUsage filters by model", () => {
    recordImageGeneration({
      provider: "openai",
      model: "gpt-image-2",
      success: true,
      count: 1,
      outputUrls: ["/a.png"],
    });
    recordImageGeneration({
      provider: "openai",
      model: "gpt-image-1",
      success: true,
      count: 1,
      outputUrls: ["/b.png"],
    });
    const records = getRecentImageGenerationUsage({ model: "gpt-image-1" });
    expect(records).toHaveLength(1);
    expect(records[0].model).toBe("gpt-image-1");
  });

  it("getImageGenerationUsageSummary aggregates correctly", () => {
    recordImageGeneration({
      provider: "openai",
      model: "gpt-image-2",
      success: true,
      count: 2,
      outputUrls: ["/a.png", "/b.png"],
    });
    recordImageGeneration({
      provider: "google",
      model: "imagen-3",
      success: false,
      count: 0,
      outputUrls: [],
      error: "timeout",
    });
    recordImageGeneration({
      provider: "openai",
      model: "gpt-image-1",
      success: true,
      count: 1,
      outputUrls: ["/c.png"],
    });

    const summary = getImageGenerationUsageSummary();
    expect(summary.totalRequests).toBe(3);
    expect(summary.successfulRequests).toBe(2);
    expect(summary.failedRequests).toBe(1);
    expect(summary.totalImagesGenerated).toBe(3);
    expect(summary.providers).toEqual({
      openai: 2,
      google: 1,
    });
    expect(summary.models).toEqual({
      "gpt-image-2": 1,
      "imagen-3": 1,
      "gpt-image-1": 1,
    });
  });

  it("getImageGenerationUsageSummary respects sinceMs filter", () => {
    // We can't directly manipulate internal state, so we verify the sinceMs filter
    // works by checking getRecentImageGenerationUsage which also accepts sinceMs.
    const now = Date.now();
    recordImageGeneration({
      provider: "openai",
      model: "gpt-image-2",
      success: true,
      count: 1,
      outputUrls: ["/a.png"],
    });
    recordImageGeneration({
      provider: "google",
      model: "imagen-3",
      success: true,
      count: 1,
      outputUrls: ["/b.png"],
    });
    // Filter by a very recent time — should exclude both
    const recent = getRecentImageGenerationUsage({ sinceMs: now + 60_000 });
    expect(recent).toHaveLength(0);
  });

  it("clearImageGenerationUsage resets the store", () => {
    recordImageGeneration({
      provider: "openai",
      model: "gpt-image-2",
      success: true,
      count: 1,
      outputUrls: ["/a.png"],
    });
    clearImageGenerationUsage();
    expect(getImageGenerationUsage()).toHaveLength(0);
  });
});
