import { describe, expect, it } from "vitest";
import { startMockAnthropic } from "../../scripts/e2e/lib/anthropic-cache/mock-provider.mts";

async function sendRequests(baseUrl: string, count: number) {
  for (let index = 0; index < count; index += 1) {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: `request-${index}` }],
      }),
    });
    expect(response.ok).toBe(true);
    await response.text();
  }
}

describe("startMockAnthropic", () => {
  it.each([4, 8])("accepts exactly %i selected-lane requests", async (expectedRequests) => {
    const mock = await startMockAnthropic();
    try {
      await sendRequests(mock.baseUrl, expectedRequests);
      expect(() => mock.assertComplete(expectedRequests)).not.toThrow();
    } finally {
      await mock.close();
    }
  });

  it("rejects a provider-only count when both lanes were selected", async () => {
    const mock = await startMockAnthropic();
    try {
      await sendRequests(mock.baseUrl, 4);
      expect(() => mock.assertComplete(8)).toThrow("expected 8 installed-builder HTTP requests");
    } finally {
      await mock.close();
    }
  });
});
