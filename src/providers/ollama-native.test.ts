import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkOllamaAvailability, ollamaChat } from "./ollama-native.js";

describe("ollama native provider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sanitizes the baseUrl and posts to /api/chat", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          content: "ok",
        },
      }),
    });

    const messages = [{ role: "user", content: "hello" }];
    const response = await ollamaChat(
      { baseUrl: "http://tars.local:11434/v1", model: "qwen2.5" },
      messages,
      undefined,
      { temperature: 0.25, maxTokens: 150 },
    );

    expect(response.content).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://tars.local:11434/api/chat");
    expect(options.method).toBe("POST");

    const parsedBody = JSON.parse(bodyToString(options.body));
    expect(parsedBody).toMatchObject({
      model: "qwen2.5",
      messages,
      stream: false,
      options: { temperature: 0.25, num_predict: 150 },
    });
  });

  it("adds Authorization header when a non-ollama-local apiKey is provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: "" } }),
    });

    await ollamaChat(
      { baseUrl: "http://example.com", model: "llama3.3", apiKey: "secret" },
      [{ role: "system", content: "hi" }],
      undefined,
    );

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
    });
  });

  it("does not attach Authorization header when apiKey is ollama-local", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: "" } }),
    });

    await ollamaChat(
      { baseUrl: "http://example.com", model: "llama3.3", apiKey: "ollama-local" },
      [{ role: "system", content: "hi" }],
      undefined,
    );

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("reports availability when the requested model exists", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "qwen2.5-coder:32b" }] }),
    });

    const result = await checkOllamaAvailability("http://tars.local:11434", "qwen2.5-coder:32b");
    expect(result.available).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://tars.local:11434/api/tags", expect.any(Object));
  });

  it("reports unavailable when /api/tags returns not ok", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "boom",
    });

    const result = await checkOllamaAvailability("http://127.0.0.1:11434", "llama3.3");
    expect(result.available).toBe(false);
    expect(result.error).toContain("500");
  });

  it("reports unavailable when fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("network"));

    const result = await checkOllamaAvailability("http://127.0.0.1:11434", "llama3.3");
    expect(result.available).toBe(false);
    expect(result.error).toContain("Cannot connect to Ollama");
  });
});

const textDecoder = new TextDecoder();

function bodyToString(body: BodyInit | null | undefined): string {
  if (typeof body === "string") {
    return body;
  }

  if (!body) {
    return "";
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  if (body instanceof ArrayBuffer) {
    return textDecoder.decode(new Uint8Array(body));
  }

  if (body instanceof Uint8Array) {
    return textDecoder.decode(body);
  }

  if (
    typeof body === "object" &&
    typeof (body as { toString?: () => string }).toString === "function"
  ) {
    return body.toString();
  }

  throw new Error("Unable to decode fetch body");
}
