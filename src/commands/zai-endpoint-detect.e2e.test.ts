import { describe, expect, it } from "vitest";
import { detectZaiEndpoint } from "./zai-endpoint-detect.js";

function makeFetch(map: Record<string, { status: number; body?: unknown }>) {
  return (async (url: string, init?: RequestInit) => {
    let model = "";
    try {
      const rawBody = init?.body;
      if (typeof rawBody === "string") {
        const parsed = JSON.parse(rawBody) as { model?: unknown };
        if (typeof parsed.model === "string") {
          model = parsed.model;
        }
      }
    } catch {
      // ignore malformed body in tests
    }
    const modelKey = model ? `${url}::${model}` : "";
    const entry = (modelKey && map[modelKey]) || map[url];
    if (!entry) {
      throw new Error(`unexpected url: ${url}`);
    }
    const json = entry.body ?? {};
    return new Response(JSON.stringify(json), {
      status: entry.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("detectZaiEndpoint", () => {
  it("prefers global glm-5 when it works", async () => {
    const fetchFn = makeFetch({
      "https://api.z.ai/api/paas/v4/chat/completions": { status: 200 },
    });

    const detected = await detectZaiEndpoint({ apiKey: "sk-test", fetchFn });
    expect(detected?.endpoint).toBe("global");
    expect(detected?.modelId).toBe("glm-5");
  });

  it("falls back to cn glm-5 when global fails", async () => {
    const fetchFn = makeFetch({
      "https://api.z.ai/api/paas/v4/chat/completions": {
        status: 404,
        body: { error: { message: "not found" } },
      },
      "https://open.bigmodel.cn/api/paas/v4/chat/completions": { status: 200 },
    });

    const detected = await detectZaiEndpoint({ apiKey: "sk-test", fetchFn });
    expect(detected?.endpoint).toBe("cn");
    expect(detected?.modelId).toBe("glm-5");
  });

  it("uses glm-5 on coding endpoint when available", async () => {
    const fetchFn = makeFetch({
      "https://api.z.ai/api/paas/v4/chat/completions": { status: 404 },
      "https://open.bigmodel.cn/api/paas/v4/chat/completions": { status: 404 },
      "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-5": { status: 200 },
    });

    const detected = await detectZaiEndpoint({ apiKey: "sk-test", fetchFn });
    expect(detected?.endpoint).toBe("coding-global");
    expect(detected?.modelId).toBe("glm-5");
  });

  it("falls back to coding endpoint with glm-4.7 when coding glm-5 fails", async () => {
    const fetchFn = makeFetch({
      "https://api.z.ai/api/paas/v4/chat/completions": { status: 404 },
      "https://open.bigmodel.cn/api/paas/v4/chat/completions": { status: 404 },
      "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-5": { status: 404 },
      "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-5": { status: 404 },
      "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-4.7": { status: 200 },
    });

    const detected = await detectZaiEndpoint({ apiKey: "sk-test", fetchFn });
    expect(detected?.endpoint).toBe("coding-global");
    expect(detected?.modelId).toBe("glm-4.7");
  });

  it("returns null when nothing works", async () => {
    const fetchFn = makeFetch({
      "https://api.z.ai/api/paas/v4/chat/completions": { status: 401 },
      "https://open.bigmodel.cn/api/paas/v4/chat/completions": { status: 401 },
      "https://api.z.ai/api/coding/paas/v4/chat/completions": { status: 401 },
      "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions": { status: 401 },
    });

    const detected = await detectZaiEndpoint({ apiKey: "sk-test", fetchFn });
    expect(detected).toBe(null);
  });
});
