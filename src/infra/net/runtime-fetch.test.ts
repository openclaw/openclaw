import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRuntimeDispatcher } from "./runtime-fetch.js";
import { TEST_UNDICI_RUNTIME_DEPS_KEY } from "./undici-runtime.js";

class MockRuntimeFormData {
  private readonly values: Array<[string, unknown, string | undefined]> = [];

  append(name: string, value: unknown, filename?: string): void {
    this.values.push([name, value, filename]);
  }

  entries(): IterableIterator<[string, unknown]> {
    return this.values.map(([name, value]) => [name, value] as [string, unknown])[Symbol.iterator]();
  }

  getAll(name: string): unknown[] {
    return this.values.filter(([key]) => key === name).map(([, value]) => value);
  }

  getFileName(name: string): string | undefined {
    return this.values.find(([key]) => key === name)?.[2];
  }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
});

describe("fetchWithRuntimeDispatcher", () => {
  it("rebuilds global FormData with runtime FormData and drops stale multipart headers", async () => {
    const runtimeFetch = vi.fn(async () => new Response("ok"));
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: class {},
      EnvHttpProxyAgent: class {},
      ProxyAgent: class {},
      FormData: MockRuntimeFormData,
      fetch: runtimeFetch,
    };

    const form = new FormData();
    const file = new File([new Uint8Array([1, 2, 3])], "voice.ogg", { type: "audio/ogg" });
    form.append("file", file);
    form.append("model", "gpt-4o-transcribe");
    form.append("language", "cs");

    await fetchWithRuntimeDispatcher("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "multipart/form-data; boundary=stale",
        "content-length": "123",
      },
      body: form,
    });

    const [, init] = runtimeFetch.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(MockRuntimeFormData);
    const runtimeBody = init.body as unknown as MockRuntimeFormData;
    expect(runtimeBody.getAll("model")).toEqual(["gpt-4o-transcribe"]);
    expect(runtimeBody.getAll("language")).toEqual(["cs"]);
    expect(runtimeBody.getFileName("file")).toBe("voice.ogg");

    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.has("content-type")).toBe(false);
    expect(headers.has("content-length")).toBe(false);
  });
});
