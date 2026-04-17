import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "./fetch-guard.js";
import { TEST_UNDICI_RUNTIME_DEPS_KEY } from "./undici-runtime.js";

/**
 * Regression coverage for the cross-realm FormData × dispatcher bug.
 *
 * Reproduction (before the fix):
 * - `new FormData()` allocates an instance in one undici realm (e.g. Node's
 *   built-in undici when `FormData` is resolved via `globalThis`).
 * - The SSRF guard attaches a `dispatcher` from OpenClaw's bundled
 *   `undici` (a separate realm) to the RequestInit.
 * - When the caller passes a custom non-ambient `fetchImpl`
 *   (`supportsDispatcherInit === true`), the guard routes the call through
 *   that fetchImpl *with* the dispatcher attached. The dispatcher's own
 *   `body instanceof this.FormData` check fails across realms, so the
 *   request serialises the body as a non-multipart payload and providers
 *   like Groq reject it with HTTP 400
 *   `"request Content-Type isn't multipart/form-data"`.
 *
 * Fix: when `init.body` is FormData-like and a `dispatcher` is attached, the
 * guard now unconditionally routes through `fetchWithRuntimeDispatcher`, which
 * re-materialises the FormData into the bundled undici's realm before
 * dispatching.
 */

class RuntimeFormData {
  readonly records: Array<{ name: string; value: unknown; filename?: string }> = [];

  append(name: string, value: unknown, filename?: string): void {
    this.records.push({
      name,
      value,
      ...(typeof filename === "string" ? { filename } : {}),
    });
  }

  *entries(): IterableIterator<[string, unknown]> {
    for (const record of this.records) {
      yield [record.name, record.value];
    }
  }

  get [Symbol.toStringTag](): string {
    return "FormData";
  }
}

class MockAgent {
  readonly __testStub = true;
}
class MockEnvHttpProxyAgent {
  readonly __testStub = true;
}
class MockProxyAgent {
  readonly __testStub = true;
}

type LookupFn = NonNullable<Parameters<typeof import("./fetch-guard.js").fetchWithSsrFGuard>[0]["lookupFn"]>;
// Deterministic public-IP lookup so the SSRF guard does not try to
// resolve real DNS during the test (which would be flaky in CI and could
// resolve api.groq.com to a corporate-proxy'd private address).
const publicLookup = (): LookupFn =>
  vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
});

describe("fetchWithSsrFGuard (cross-realm FormData)", () => {
  it("routes FormData bodies through the bundled undici fetch even when a custom fetchImpl is supplied", async () => {
    const runtimeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      // normalizeRuntimeRequestInit should have rebuilt the body as
      // RuntimeFormData (the bundled-undici FormData stub in this test) and
      // dropped the stale content-type so undici can set a fresh multipart
      // boundary.
      const body = init?.body as unknown as RuntimeFormData;
      expect(body).toBeInstanceOf(RuntimeFormData);
      expect(body.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "model", value: "whisper-large-v3-turbo" }),
          expect.objectContaining({ name: "file", filename: "clip.wav" }),
        ]),
      );
      const headers = new Headers(init?.headers);
      expect(headers.has("content-type")).toBe(false);
      expect(headers.has("content-length")).toBe(false);
      return new Response("ok", { status: 200 });
    });

    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: MockAgent,
      EnvHttpProxyAgent: MockEnvHttpProxyAgent,
      FormData: RuntimeFormData,
      ProxyAgent: MockProxyAgent,
      fetch: runtimeFetch,
    };

    // Caller-supplied fetchImpl that is *not* the ambient global fetch and
    // does not declare dispatcher support. Plain function (not vi.fn) so
    // isMockedFetch() does not treat it as a test mock. Before the fix this
    // would be chosen over the runtime fetch and would receive the
    // cross-realm FormData untouched.
    let callerCalls = 0;
    const callerFetch = async () => {
      callerCalls += 1;
      return new Response("should-not-be-called", { status: 599 });
    };

    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
      "clip.wav",
    );
    form.append("model", "whisper-large-v3-turbo");

    const result = await fetchWithSsrFGuard({
      url: "https://api.groq.com/openai/v1/audio/transcriptions",
      fetchImpl: callerFetch,
      lookupFn: publicLookup(),
      // dispatcherPolicy mode:"direct" + pinDns:false reproduces the
      // media-understanding path, which attaches a direct-mode dispatcher
      // and then triggered the realm mismatch in production.
      dispatcherPolicy: { mode: "direct" },
      pinDns: false,
      init: {
        method: "POST",
        headers: new Headers({ authorization: "Bearer test" }),
        body: form,
      },
    });

    expect(result.response.status).toBe(200);
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(callerCalls).toBe(0);

    await result.release();
  });

  it("still routes JSON bodies through the caller-supplied fetchImpl (no regression on non-FormData)", async () => {
    let runtimeFetchCalls = 0;
    const runtimeFetch = async () => {
      runtimeFetchCalls += 1;
      return new Response("should-not-be-called", { status: 599 });
    };
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: MockAgent,
      EnvHttpProxyAgent: MockEnvHttpProxyAgent,
      FormData: RuntimeFormData,
      ProxyAgent: MockProxyAgent,
      fetch: runtimeFetch,
    };

    let callerCalls = 0;
    const callerFetch = async () => {
      callerCalls += 1;
      return new Response("ok", { status: 200 });
    };

    const result = await fetchWithSsrFGuard({
      url: "https://api.groq.com/openai/v1/chat/completions",
      fetchImpl: callerFetch,
      lookupFn: publicLookup(),
      dispatcherPolicy: { mode: "direct" },
      pinDns: false,
      init: {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({ model: "llama3", messages: [] }),
      },
    });

    expect(result.response.status).toBe(200);
    expect(callerCalls).toBe(1);
    expect(runtimeFetchCalls).toBe(0);

    await result.release();
  });
});
