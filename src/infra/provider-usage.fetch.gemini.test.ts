import { describe, expect, it, vi } from "vitest";
import { fetchGeminiUsage } from "./provider-usage.fetch.gemini.js";

const makeResponse = (status: number, body: unknown): Response => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const headers = typeof body === "string" ? undefined : { "Content-Type": "application/json" };
    return new Response(payload, { status, headers });
};

describe("fetchGeminiUsage", () => {
    it("returns individual model quotas with reset times", async () => {
        const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async () => {
            return makeResponse(200, {
                buckets: [
                    {
                        modelId: "gemini-2.0-pro",
                        remainingFraction: 0.6,
                        resetTime: "2026-01-08T00:00:00Z",
                    },
                    {
                        modelId: "gemini-2.5-flash",
                        remainingFraction: 0.8,
                        resetTime: "2026-01-08T00:00:00Z",
                    },
                ],
            });
        });

        const snapshot = await fetchGeminiUsage("token-123", 5000, mockFetch, "google-gemini-cli");

        expect(snapshot.provider).toBe("google-gemini-cli");
        expect(snapshot.displayName).toBe("Gemini");
        expect(snapshot.windows).toHaveLength(2);
        expect(snapshot.error).toBeUndefined();

        // Sorted by usage (highest first)
        const proWindow = snapshot.windows.find((w) => w.label === "gemini-2.0-pro");
        expect(proWindow?.usedPercent).toBe(40); // (1 - 0.6) * 100
        expect(proWindow?.resetAt).toBe(new Date("2026-01-08T00:00:00Z").getTime());

        const flashWindow = snapshot.windows.find((w) => w.label === "gemini-2.5-flash");
        expect(flashWindow?.usedPercent).toBeCloseTo(20, 1); // (1 - 0.8) * 100
        expect(flashWindow?.resetAt).toBe(new Date("2026-01-08T00:00:00Z").getTime());
    });

    it("skips internal models (chat_*, tab_*)", async () => {
        const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async () => {
            return makeResponse(200, {
                buckets: [
                    { modelId: "chat_hidden", remainingFraction: 0.1 },
                    { modelId: "tab_hidden", remainingFraction: 0.2 },
                    { modelId: "gemini-pro-1.5", remainingFraction: 0.7 },
                ],
            });
        });

        const snapshot = await fetchGeminiUsage("token-123", 5000, mockFetch, "google-gemini-cli");

        expect(snapshot.windows.map((w) => w.label)).toEqual(["gemini-pro-1.5"]);
    });

    it("sorts models by usage (highest first)", async () => {
        const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async () => {
            return makeResponse(200, {
                buckets: [
                    { modelId: "gemini-pro-1.0", remainingFraction: 0.8 },
                    { modelId: "gemini-pro-1.5", remainingFraction: 0.3 },
                    { modelId: "gemini-flash-1.5", remainingFraction: 0.6 },
                ],
            });
        });

        const snapshot = await fetchGeminiUsage("token-123", 5000, mockFetch, "google-gemini-cli");

        expect(snapshot.windows).toHaveLength(3);
        expect(snapshot.windows[0]?.label).toBe("gemini-pro-1.5");
        expect(snapshot.windows[0]?.usedPercent).toBe(70); // (1 - 0.3) * 100
        expect(snapshot.windows[1]?.label).toBe("gemini-flash-1.5");
        expect(snapshot.windows[1]?.usedPercent).toBe(40); // (1 - 0.6) * 100
        expect(snapshot.windows[2]?.label).toBe("gemini-pro-1.0");
        expect(snapshot.windows[2]?.usedPercent).toBeCloseTo(20, 1); // (1 - 0.8) * 100
    });

    it("limits to top 10 models", async () => {
        const buckets = Array.from({ length: 15 }, (_, i) => ({
            modelId: `gemini-model-${i}`,
            remainingFraction: 0.1 * i,
        }));
        const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async () => {
            return makeResponse(200, { buckets });
        });

        const snapshot = await fetchGeminiUsage("token-123", 5000, mockFetch, "google-gemini-cli");

        expect(snapshot.windows).toHaveLength(10);
    });

    it("returns Token expired error on 401", async () => {
        const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async () => {
            return makeResponse(401, { error: { message: "Unauthorized" } });
        });

        const snapshot = await fetchGeminiUsage("token-123", 5000, mockFetch, "google-gemini-cli");

        expect(snapshot.error).toBe("Token expired");
        expect(snapshot.windows).toHaveLength(0);
    });

    it("returns HTTP error on non-401 failures", async () => {
        const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async () => {
            return makeResponse(500, "Internal server error");
        });

        const snapshot = await fetchGeminiUsage("token-123", 5000, mockFetch, "google-gemini-cli");

        expect(snapshot.error).toBe("HTTP 500");
        expect(snapshot.windows).toHaveLength(0);
    });

    it("handles empty buckets gracefully", async () => {
        const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async () => {
            return makeResponse(200, { buckets: [] });
        });

        const snapshot = await fetchGeminiUsage("token-123", 5000, mockFetch, "google-gemini-cli");

        expect(snapshot.windows).toHaveLength(0);
        expect(snapshot.error).toBeUndefined();
    });

    it("handles missing modelId gracefully", async () => {
        const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async () => {
            return makeResponse(200, {
                buckets: [
                    { remainingFraction: 0.5 },
                    { modelId: "gemini-flash", remainingFraction: 0.7 },
                ],
            });
        });

        const snapshot = await fetchGeminiUsage("token-123", 5000, mockFetch, "google-gemini-cli");

        expect(snapshot.windows).toHaveLength(1);
        expect(snapshot.windows[0]?.label).toBe("gemini-flash");
    });

    it("handles invalid reset time gracefully", async () => {
        const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async () => {
            return makeResponse(200, {
                buckets: [
                    { modelId: "gemini-pro-test", remainingFraction: 0.4, resetTime: "invalid-date" },
                ],
            });
        });

        const snapshot = await fetchGeminiUsage("token-123", 5000, mockFetch, "google-gemini-cli");

        const proWindow = snapshot.windows.find((w) => w.label === "gemini-pro-test");
        expect(proWindow?.usedPercent).toBe(60);
        expect(proWindow?.resetAt).toBeUndefined();
    });
});
