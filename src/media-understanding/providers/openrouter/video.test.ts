import { describe, expect, it } from "vitest";
import {
  createAuthCaptureJsonFetch,
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../audio.test-helpers.js";
import { describeOpenRouterVideo } from "./video.js";

installPinnedHostnameTestHooks();

describe("describeOpenRouterVideo", () => {
  it("builds an OpenRouter chat completions request with video data URL", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "video description" } }],
    });

    const result = await describeOpenRouterVideo({
      buffer: Buffer.from("video-bytes"),
      fileName: "clip.mp4",
      apiKey: "or-test-key",
      timeoutMs: 1500,
      baseUrl: "https://openrouter.ai/api/v1/",
      model: "google/gemini-3-flash-preview",
      headers: { "X-Trace": "1" },
      fetchFn,
    });
    const { url, init } = getRequest();

    expect(result.text).toBe("video description");
    expect(result.model).toBe("google/gemini-3-flash-preview");
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer or-test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-trace")).toBe("1");

    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      model?: string;
      messages?: Array<{
        content?: Array<{
          type?: string;
          text?: string;
          video_url?: { url?: string };
        }>;
      }>;
    };
    expect(body.model).toBe("google/gemini-3-flash-preview");
    expect(body.messages?.[0]?.content?.[0]).toMatchObject({
      type: "text",
      text: "Describe the video.",
    });
    expect(body.messages?.[0]?.content?.[1]?.type).toBe("video_url");
    expect(body.messages?.[0]?.content?.[1]?.video_url?.url).toBe(
      `data:video/mp4;base64,${Buffer.from("video-bytes").toString("base64")}`,
    );
  });

  it("respects authorization header overrides", async () => {
    const { fetchFn, getAuthHeader } = createAuthCaptureJsonFetch({
      choices: [{ message: { content: "ok" } }],
    });

    const result = await describeOpenRouterVideo({
      buffer: Buffer.from("video"),
      fileName: "clip.mp4",
      apiKey: "test-key",
      timeoutMs: 1000,
      headers: { authorization: "Bearer override" },
      fetchFn,
    });

    expect(getAuthHeader()).toBe("Bearer override");
    expect(result.text).toBe("ok");
  });

  it("uses default model when model is empty", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "described" } }],
    });

    const result = await describeOpenRouterVideo({
      buffer: Buffer.from("video"),
      fileName: "clip.mp4",
      apiKey: "key",
      timeoutMs: 1000,
      model: "  ",
      fetchFn,
    });

    expect(result.model).toBe("google/gemini-3-flash-preview");
    const { init } = getRequest();
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    expect(body.model).toBe("google/gemini-3-flash-preview");
  });

  it("uses custom prompt when provided", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "done" } }],
    });

    await describeOpenRouterVideo({
      buffer: Buffer.from("video"),
      fileName: "clip.mp4",
      apiKey: "key",
      timeoutMs: 1000,
      prompt: " Summarize this video ",
      fetchFn,
    });

    const { init } = getRequest();
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    expect(body.messages?.[0]?.content?.[0]?.text).toBe("Summarize this video");
  });

  it("throws when the response has no content", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "" } }],
    });

    await expect(
      describeOpenRouterVideo({
        buffer: Buffer.from("video"),
        fileName: "clip.mp4",
        apiKey: "key",
        timeoutMs: 1000,
        fetchFn,
      }),
    ).rejects.toThrow("OpenRouter video description response missing content");
  });

  it("defaults mime to video/mp4", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "ok" } }],
    });

    await describeOpenRouterVideo({
      buffer: Buffer.from("video"),
      fileName: "clip.mp4",
      apiKey: "key",
      timeoutMs: 1000,
      fetchFn,
    });

    const { init } = getRequest();
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    expect(body.messages?.[0]?.content?.[1]?.video_url?.url).toContain("data:video/mp4;base64,");
  });
});
