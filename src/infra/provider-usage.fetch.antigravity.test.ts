import { describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { fetchAntigravityUsage } from "./provider-usage.fetch.antigravity.js";

const makeResponse = (status: number, body: unknown): Response => {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const headers = typeof body === "string" ? undefined : { "Content-Type": "application/json" };
  return new Response(payload, { status, headers });
};

const toRequestUrl = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

const createAntigravityFetch = (
  handler: (url: string, init?: Parameters<typeof fetch>[1]) => Promise<Response> | Response,
) => {
  const mockFetch = vi.fn(async (input: string | Request | URL, init?: RequestInit) =>
    handler(toRequestUrl(input), init),
  );
  return withFetchPreconnect(mockFetch) as typeof fetch & typeof mockFetch;
};

const getRequestBody = (init?: Parameters<typeof fetch>[1]) =>
  typeof init?.body === "string" ? init.body : undefined;

type EndpointHandler = (init?: Parameters<typeof fetch>[1]) => Promise<Response> | Response;

function createEndpointFetch(spec: {
  loadCodeAssist?: EndpointHandler;
  fetchAvailableModels?: EndpointHandler;
}) {
  return createAntigravityFetch(async (url, init) => {
    if (url.includes("loadCodeAssist")) {
      return (await spec.loadCodeAssist?.(init)) ?? makeResponse(404, "not found");
    }
    if (url.includes("fetchAvailableModels")) {
      return (await spec.fetchAvailableModels?.(init)) ?? makeResponse(404, "not found");
    }
    return makeResponse(404, "not found");
  });
}

async function runUsage(mockFetch: ReturnType<typeof createAntigravityFetch>) {
  return fetchAntigravityUsage("token-123", 5000, mockFetch as unknown as typeof fetch);
}

function findWindow(snapshot: Awaited<ReturnType<typeof fetchAntigravityUsage>>, label: string) {
  return snapshot.windows.find((window) => window.label === label);
}

describe("fetchAntigravityUsage", () => {
  it("returns 3 windows when both endpoints succeed", async () => {
    const mockFetch = createEndpointFetch({
      loadCodeAssist: () =>
        makeResponse(200, {
          availablePromptCredits: 750,
          planInfo: { monthlyPromptCredits: 1000 },
          planType: "Standard",
          currentTier: { id: "tier1", name: "Standard Tier" },
        }),
      fetchAvailableModels: () =>
        makeResponse(200, {
          models: {
            "gemini-pro-1.5": {
              quotaInfo: {
                remainingFraction: 0.6,
                resetTime: "2026-01-08T00:00:00Z",
                isExhausted: false,
              },
            },
            "gemini-flash-2.0": {
              quotaInfo: {
                remainingFraction: 0.8,
                resetTime: "2026-01-08T00:00:00Z",
                isExhausted: false,
              },
            },
          },
        }),
    });

    const snapshot = await runUsage(mockFetch);

    expect(snapshot.provider).toBe("google-antigravity");
    expect(snapshot.displayName).toBe("Antigravity");
    expect(snapshot.windows).toHaveLength(3);
    expect(snapshot.plan).toBe("Standard Tier");
    expect(snapshot.error).toBeUndefined();

    const creditsWindow = findWindow(snapshot, "Credits");
    expect(creditsWindow?.usedPercent).toBe(25); // (1000 - 750) / 1000 * 100

    const proWindow = findWindow(snapshot, "gemini-pro-1.5");
    expect(proWindow?.usedPercent).toBe(40); // (1 - 0.6) * 100
    expect(proWindow?.resetAt).toBe(new Date("2026-01-08T00:00:00Z").getTime());

    const flashWindow = findWindow(snapshot, "gemini-flash-2.0");
    expect(flashWindow?.usedPercent).toBeCloseTo(20, 1); // (1 - 0.8) * 100
    expect(flashWindow?.resetAt).toBe(new Date("2026-01-08T00:00:00Z").getTime());

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns Credits only when loadCodeAssist succeeds but fetchAvailableModels fails", async () => {
    const mockFetch = createEndpointFetch({
      loadCodeAssist: () =>
        makeResponse(200, {
          availablePromptCredits: 250,
          planInfo: { monthlyPromptCredits: 1000 },
          currentTier: { name: "Free" },
        }),
      fetchAvailableModels: () => makeResponse(403, { error: { message: "Permission denied" } }),
    });

    const snapshot = await runUsage(mockFetch);

    expect(snapshot.provider).toBe("google-antigravity");
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.plan).toBe("Free");
    expect(snapshot.error).toBeUndefined();

    const creditsWindow = snapshot.windows[0];
    expect(creditsWindow?.label).toBe("Credits");
    expect(creditsWindow?.usedPercent).toBe(75); // (1000 - 250) / 1000 * 100

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns model IDs when fetchAvailableModels succeeds but loadCodeAssist fails", async () => {
    const mockFetch = createEndpointFetch({
      loadCodeAssist: () => makeResponse(500, "Internal server error"),
      fetchAvailableModels: () =>
        makeResponse(200, {
          models: {
            "gemini-pro-1.5": {
              quotaInfo: { remainingFraction: 0.5, resetTime: "2026-01-08T00:00:00Z" },
            },
            "gemini-flash-2.0": {
              quotaInfo: { remainingFraction: 0.7, resetTime: "2026-01-08T00:00:00Z" },
            },
          },
        }),
    });

    const snapshot = await runUsage(mockFetch);

    expect(snapshot.provider).toBe("google-antigravity");
    expect(snapshot.windows).toHaveLength(2);
    expect(snapshot.error).toBeUndefined();

    const proWindow = findWindow(snapshot, "gemini-pro-1.5");
    expect(proWindow?.usedPercent).toBe(50); // (1 - 0.5) * 100

    const flashWindow = findWindow(snapshot, "gemini-flash-2.0");
    expect(flashWindow?.usedPercent).toBeCloseTo(30, 1); // (1 - 0.7) * 100

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "uses cloudaicompanionProject string as project id",
      project: "projects/alpha",
      expectedBody: JSON.stringify({ project: "projects/alpha" }),
    },
    {
      name: "uses cloudaicompanionProject object id when present",
      project: { id: "projects/beta" },
      expectedBody: JSON.stringify({ project: "projects/beta" }),
    },
  ])("$name", async ({ project, expectedBody }) => {
    let capturedBody: string | undefined;
    const mockFetch = createEndpointFetch({
      loadCodeAssist: () =>
        makeResponse(200, {
          availablePromptCredits: 900,
          planInfo: { monthlyPromptCredits: 1000 },
          cloudaicompanionProject: project,
        }),
      fetchAvailableModels: (init) => {
        capturedBody = getRequestBody(init);
        return makeResponse(200, { models: {} });
      },
    });

    await runUsage(mockFetch);
    expect(capturedBody).toBe(expectedBody);
  });

  it("returns error snapshot when both endpoints fail", async () => {
    const mockFetch = createEndpointFetch({
      loadCodeAssist: () => makeResponse(403, { error: { message: "Access denied" } }),
      fetchAvailableModels: () => makeResponse(403, "Forbidden"),
    });

    const snapshot = await runUsage(mockFetch);

    expect(snapshot.provider).toBe("google-antigravity");
    expect(snapshot.windows).toHaveLength(0);
    expect(snapshot.error).toBe("Access denied");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns Token expired when fetchAvailableModels returns 401 and no windows", async () => {
    const mockFetch = createEndpointFetch({
      loadCodeAssist: () => makeResponse(500, "Boom"),
      fetchAvailableModels: () => makeResponse(401, { error: { message: "Unauthorized" } }),
    });

    const snapshot = await runUsage(mockFetch);

    expect(snapshot.error).toBe("Token expired");
    expect(snapshot.windows).toHaveLength(0);
  });

  it.each([
    {
      name: "extracts plan info from currentTier.name",
      loadCodeAssist: {
        availablePromptCredits: 500,
        planInfo: { monthlyPromptCredits: 1000 },
        planType: "Basic",
        currentTier: { id: "tier2", name: "Premium Tier" },
      },
      expectedPlan: "Premium Tier",
    },
    {
      name: "falls back to planType when currentTier.name is missing",
      loadCodeAssist: {
        availablePromptCredits: 500,
        planInfo: { monthlyPromptCredits: 1000 },
        planType: "Basic Plan",
      },
      expectedPlan: "Basic Plan",
    },
  ])("$name", async ({ loadCodeAssist, expectedPlan }) => {
    const mockFetch = createEndpointFetch({
      loadCodeAssist: () => makeResponse(200, loadCodeAssist),
      fetchAvailableModels: () => makeResponse(500, "Error"),
    });

    const snapshot = await runUsage(mockFetch);
    expect(snapshot.plan).toBe(expectedPlan);
  });

  it("includes reset times in model windows", async () => {
    const resetTime = "2026-01-10T12:00:00Z";
    const mockFetch = createAntigravityFetch(async (url) => {
      if (url.includes("loadCodeAssist")) {
        return makeResponse(500, "Error");
      }

      if (url.includes("fetchAvailableModels")) {
        return makeResponse(200, {
          models: {
            "gemini-pro-experimental": {
              quotaInfo: { remainingFraction: 0.3, resetTime },
            },
          },
        });
      }

      return makeResponse(404, "not found");
    });

    const snapshot = await fetchAntigravityUsage("token-123", 5000, mockFetch);

    const proWindow = snapshot.windows.find((w) => w.label === "gemini-pro-experimental");
    expect(proWindow?.resetAt).toBe(new Date(resetTime).getTime());
  });

  it("parses string numbers correctly", async () => {
    const mockFetch = createAntigravityFetch(async (url) => {
      if (url.includes("loadCodeAssist")) {
        return makeResponse(200, {
          availablePromptCredits: "600",
          planInfo: { monthlyPromptCredits: "1000" },
        });
      }

      if (url.includes("fetchAvailableModels")) {
        return makeResponse(200, {
          models: {
            "gemini-flash-lite": {
              quotaInfo: { remainingFraction: "0.9" },
            },
          },
        });
      }

      return makeResponse(404, "not found");
    });

    const snapshot = await fetchAntigravityUsage("token-123", 5000, mockFetch);

    expect(snapshot.windows).toHaveLength(2);

    const creditsWindow = snapshot.windows.find((w) => w.label === "Credits");
    expect(creditsWindow?.usedPercent).toBe(40); // (1000 - 600) / 1000 * 100

    const flashWindow = snapshot.windows.find((w) => w.label === "gemini-flash-lite");
    expect(flashWindow?.usedPercent).toBeCloseTo(10, 1); // (1 - 0.9) * 100
  });

  it("skips internal models", async () => {
    const mockFetch = createAntigravityFetch(async (url) => {
      if (url.includes("loadCodeAssist")) {
        return makeResponse(200, {
          availablePromptCredits: 500,
          planInfo: { monthlyPromptCredits: 1000 },
          cloudaicompanionProject: "projects/internal",
        });
      }

      if (url.includes("fetchAvailableModels")) {
        return makeResponse(200, {
          models: {
            chat_hidden: { quotaInfo: { remainingFraction: 0.1 } },
            tab_hidden: { quotaInfo: { remainingFraction: 0.2 } },
            "gemini-pro-1.5": { quotaInfo: { remainingFraction: 0.7 } },
          },
        });
      }

      return makeResponse(404, "not found");
    });

    const snapshot = await fetchAntigravityUsage("token-123", 5000, mockFetch);

    expect(snapshot.windows.map((w) => w.label)).toEqual(["Credits", "gemini-pro-1.5"]);
  });

  it("sorts models by usage and shows individual model IDs", async () => {
    const mockFetch = createAntigravityFetch(async (url) => {
      if (url.includes("loadCodeAssist")) {
        return makeResponse(500, "Error");
      }

      if (url.includes("fetchAvailableModels")) {
        return makeResponse(200, {
          models: {
            "gemini-pro-1.0": {
              quotaInfo: { remainingFraction: 0.8 },
            },
            "gemini-pro-1.5": {
              quotaInfo: { remainingFraction: 0.3 },
            },
            "gemini-flash-1.5": {
              quotaInfo: { remainingFraction: 0.6 },
            },
            "gemini-flash-2.0": {
              quotaInfo: { remainingFraction: 0.9 },
            },
          },
        });
      }

      return makeResponse(404, "not found");
    });

    const snapshot = await fetchAntigravityUsage("token-123", 5000, mockFetch);

    expect(snapshot.windows).toHaveLength(4);
    // Should be sorted by usage (highest first)
    expect(snapshot.windows[0]?.label).toBe("gemini-pro-1.5");
    expect(snapshot.windows[0]?.usedPercent).toBe(70); // (1 - 0.3) * 100
    expect(snapshot.windows[1]?.label).toBe("gemini-flash-1.5");
    expect(snapshot.windows[1]?.usedPercent).toBe(40); // (1 - 0.6) * 100
    expect(snapshot.windows[2]?.label).toBe("gemini-pro-1.0");
    expect(snapshot.windows[2]?.usedPercent).toBeCloseTo(20, 1); // (1 - 0.8) * 100
    expect(snapshot.windows[3]?.label).toBe("gemini-flash-2.0");
    expect(snapshot.windows[3]?.usedPercent).toBeCloseTo(10, 1); // (1 - 0.9) * 100
  });

  it("returns Token expired error on 401 from loadCodeAssist", async () => {
    const mockFetch = createAntigravityFetch(async (url) => {
      if (url.includes("loadCodeAssist")) {
        return makeResponse(401, { error: { message: "Unauthorized" } });
      }

      return makeResponse(404, "not found");
    });

    const snapshot = await fetchAntigravityUsage("token-123", 5000, mockFetch);

    expect(snapshot.error).toBe("Token expired");
    expect(snapshot.windows).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledTimes(1); // Should stop early on 401
  });

  it("handles empty models array gracefully", async () => {
    const mockFetch = createAntigravityFetch(async (url) => {
      if (url.includes("loadCodeAssist")) {
        return makeResponse(200, {
          availablePromptCredits: 800,
          planInfo: { monthlyPromptCredits: 1000 },
        });
      }

      if (url.includes("fetchAvailableModels")) {
        return makeResponse(200, { models: {} });
      }

      return makeResponse(404, "not found");
    });

    const snapshot = await fetchAntigravityUsage("token-123", 5000, mockFetch);

    expect(snapshot.windows).toHaveLength(1);
    const creditsWindow = snapshot.windows[0];
    expect(creditsWindow?.label).toBe("Credits");
    expect(creditsWindow?.usedPercent).toBe(20);
  });

  it("handles missing credits fields gracefully", async () => {
    const mockFetch = createAntigravityFetch(async (url) => {
      if (url.includes("loadCodeAssist")) {
        return makeResponse(200, { planType: "Free" });
      }

      if (url.includes("fetchAvailableModels")) {
        return makeResponse(200, {
          models: {
            "gemini-flash-experimental": {
              quotaInfo: { remainingFraction: 0.5 },
            },
          },
        });
      }

      return makeResponse(404, "not found");
    });

    const snapshot = await fetchAntigravityUsage("token-123", 5000, mockFetch);

    expect(snapshot.windows).toHaveLength(1);
    const flashWindow = snapshot.windows[0];
    expect(flashWindow?.label).toBe("gemini-flash-experimental");
    expect(flashWindow?.usedPercent).toBe(50);
    expect(snapshot.plan).toBe("Free");
  });

  it("handles invalid reset time gracefully", async () => {
    const mockFetch = createAntigravityFetch(async (url) => {
      if (url.includes("loadCodeAssist")) {
        return makeResponse(500, "Error");
      }

      if (url.includes("fetchAvailableModels")) {
        return makeResponse(200, {
          models: {
            "gemini-pro-test": {
              quotaInfo: { remainingFraction: 0.4, resetTime: "invalid-date" },
            },
          },
        });
      }

      return makeResponse(404, "not found");
    });

    const snapshot = await fetchAntigravityUsage("token-123", 5000, mockFetch);

    const proWindow = snapshot.windows.find((w) => w.label === "gemini-pro-test");
    expect(proWindow?.usedPercent).toBe(60);
    expect(proWindow?.resetAt).toBeUndefined();
  });

  it("handles network errors with graceful degradation", async () => {
    const mockFetch = createAntigravityFetch(async (url) => {
      if (url.includes("loadCodeAssist")) {
        throw new Error("Network failure");
      }

      if (url.includes("fetchAvailableModels")) {
        return makeResponse(200, {
          models: {
            "gemini-flash-stable": {
              quotaInfo: { remainingFraction: 0.85 },
            },
          },
        });
      }

      return makeResponse(404, "not found");
    });

    const snapshot = await fetchAntigravityUsage("token-123", 5000, mockFetch);

    expect(snapshot.windows).toHaveLength(1);
    const flashWindow = snapshot.windows[0];
    expect(flashWindow?.label).toBe("gemini-flash-stable");
    expect(flashWindow?.usedPercent).toBeCloseTo(15, 1);
    expect(snapshot.error).toBeUndefined();
  });
});
