import { describe, expect, it } from "vitest";
import { detectZaiEndpoint } from "./zai-endpoint-detect.js";

function makeFetch(map: Record<string, { status: number; body?: unknown }>) {
  return (async (url: string) => {
    const entry = map[url];
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
  it("prefers global glm-5-turbo when it works", async () => {
    const fetchFn = makeFetch({
      "https://api.z.ai/api/paas/v4/chat/completions": { status: 200 },
    });

    const detected = await detectZaiEndpoint({ apiKey: "sk-test", fetchFn });
    expect(detected?.endpoint).toBe("global");
    expect(detected?.modelId).toBe("glm-5-turbo");
  });

  it("falls back to cn glm-5-turbo when global fails", async () => {
    const fetchFn = makeFetch({
      "https://api.z.ai/api/paas/v4/chat/completions": {
        status: 404,
        body: { error: { message: "not found" } },
      },
      "https://open.bigmodel.cn/api/paas/v4/chat/completions": { status: 200 },
    });

    const detected = await detectZaiEndpoint({ apiKey: "sk-test", fetchFn });
    expect(detected?.endpoint).toBe("cn");
    expect(detected?.modelId).toBe("glm-5-turbo");
  });

  it("falls back to glm-5.1 on global when turbo fails", async () => {
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (
        url === "https://api.z.ai/api/paas/v4/chat/completions" &&
        init?.body &&
        typeof init.body === "string" &&
        init.body.includes('"model":"glm-5-turbo"')
      ) {
        return new Response(JSON.stringify({ error: { message: "not found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (
        url === "https://api.z.ai/api/paas/v4/chat/completions" &&
        init?.body &&
        typeof init.body === "string" &&
        init.body.includes('"model":"glm-5.1"')
      ) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const bodySnippet =
        init?.body === undefined
          ? ""
          : typeof init.body === "string"
            ? init.body
            : JSON.stringify(init.body);
      throw new Error(`unexpected url/body: ${url} ${bodySnippet}`);
    }) as typeof fetch;

    const detected = await detectZaiEndpoint({ apiKey: "sk-test", fetchFn });
    expect(detected?.endpoint).toBe("global");
    expect(detected?.modelId).toBe("glm-5.1");
  });

  it("falls back to coding endpoint with glm-4.7", async () => {
    const fetchFn = makeFetch({
      "https://api.z.ai/api/paas/v4/chat/completions": { status: 404 },
      "https://open.bigmodel.cn/api/paas/v4/chat/completions": { status: 404 },
      "https://api.z.ai/api/coding/paas/v4/chat/completions": { status: 200 },
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
