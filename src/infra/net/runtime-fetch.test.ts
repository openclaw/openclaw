import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRuntimeDispatcher } from "./runtime-fetch.js";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

class RuntimeFormData {
  readonly records: Array<{ name: string; value: unknown; filename?: string }> = [];

  append(name: string, value: unknown, filename?: string): void {
    this.records.push({
      name,
      value,
      ...(typeof filename === "string" ? { filename } : {}),
    });
  }
}

function installRuntimeFetch() {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: vi.fn(),
    EnvHttpProxyAgent: vi.fn(),
    FormData: RuntimeFormData,
    ProxyAgent: vi.fn(),
    fetch,
  };
  return async (init: RequestInit) => {
    expect((await fetchWithRuntimeDispatcher("https://example.com", init)).status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    const sent = fetch.mock.calls[0]?.[1];
    if (!sent) {
      throw new Error("expected runtime fetch init");
    }
    return sent;
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
});

describe("fetchWithRuntimeDispatcher", () => {
  it("drops symbol metadata from plain header dictionaries before runtime fetch", async () => {
    const fetch = installRuntimeFetch();
    const headers = { "Content-Type": "application/json" };
    Object.defineProperty(headers, Symbol("sensitiveHeaders"), {
      value: new Set(["content-type"]),
      enumerable: false,
    });

    const { headers: sentHeaders } = await fetch({
      method: "POST",
      headers,
      body: "{}",
    });

    expect(new Headers(sentHeaders).get("content-type")).toBe("application/json");
    expect(sentHeaders).not.toBe(headers);
    expect(Object.getOwnPropertySymbols(sentHeaders as object)).toStrictEqual([]);
    expect(Object.getOwnPropertySymbols(headers)).toHaveLength(1);
  });

  it("normalizes global FormData bodies into the runtime FormData implementation", async () => {
    const fetch = installRuntimeFetch();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" }), "clip.ogg");
    form.append("model", "gpt-4o-transcribe");

    const sentInit = await fetch({
      method: "POST",
      headers: {
        "content-length": "999",
        "content-type": "multipart/form-data; boundary=stale",
      },
      body: form,
    });

    // BodyInit and RuntimeFormData live in separate type namespaces.
    const body = sentInit.body as unknown as RuntimeFormData;
    expect(body).toBeInstanceOf(RuntimeFormData);
    expect(body.records.find((record) => record.name === "model")?.value).toBe("gpt-4o-transcribe");
    expect(body.records.find((record) => record.name === "file")?.filename).toBe("clip.ogg");
    const sentHeaders = new Headers(sentInit.headers);
    expect(sentHeaders.has("content-length")).toBe(false);
    expect(sentHeaders.has("content-type")).toBe(false);
  });
});
