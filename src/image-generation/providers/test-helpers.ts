import { expect, vi } from "vitest";
import * as modelAuth from "../../agents/model-auth.js";

/**
 * Mock configuration for image generation provider tests
 */
export interface MockProviderConfig {
  provider: string;
  apiKey: string;
  authMode?: "api-key" | "token";
  authSource?: "env" | "profile";
}

/**
 * Mock result for image generation
 */
export interface MockImageResult {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

/**
 * Creates a mock fetch function for Google provider tests
 */
export function createGoogleFetchMock(params: {
  imageData: string;
  mimeType?: string;
  format?: "snake_case" | "camelCase";
}): ReturnType<typeof vi.fn> {
  const { imageData, mimeType = "image/png", format = "camelCase" } = params;
  const inlineDataKey = format === "snake_case" ? "inline_data" : "inlineData";
  const mimeTypeKey = format === "snake_case" ? "mime_type" : "mimeType";

  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              { text: "generated" },
              {
                [inlineDataKey]: {
                  [mimeTypeKey]: mimeType,
                  data: Buffer.from(imageData).toString("base64"),
                },
              },
            ],
          },
        },
      ],
    }),
  });
}

/**
 * Creates a mock fetch function for fal provider tests (two-call pattern)
 */
export function createFalFetchMock(params: {
  imageUrl: string;
  contentType: string;
  imageData: string;
  prompt?: string;
}): ReturnType<typeof vi.fn> {
  const { imageUrl, contentType, imageData, prompt = "draw a cat" } = params;

  return vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        images: [{ url: imageUrl, content_type: contentType }],
        prompt,
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": contentType }),
      arrayBuffer: async () => Buffer.from(imageData),
    });
}

/**
 * Mocks the model auth for a provider
 */
export function mockProviderAuth(config: MockProviderConfig): ReturnType<typeof vi.spyOn> {
  const { provider, apiKey, authMode = "api-key", authSource = "env" } = config;
  return vi.spyOn(modelAuth, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey,
    source: authSource,
    mode: authMode,
  });
}

/**
 * Asserts fetch was called with expected Google API URL and body
 */
export function expectGoogleFetchCall(
  fetchMock: ReturnType<typeof vi.fn>,
  params: {
    call?: number;
    model: string;
    prompt: string;
    aspectRatio?: string;
    imageSize?: string;
  },
) {
  const { call = 1, model, prompt, aspectRatio, imageSize } = params;
  const expectedUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  expect(fetchMock).toHaveBeenNthCalledWith(
    call,
    expectedUrl,
    expect.objectContaining({
      method: "POST",
      body: expect.any(String),
    }),
  );

  const [, init] = fetchMock.mock.calls[call - 1];
  const body = JSON.parse(String(init?.body));

  expect(body.contents).toEqual([
    {
      role: "user",
      parts: [{ text: prompt }],
    },
  ]);

  if (aspectRatio || imageSize) {
    expect(body.generationConfig?.imageConfig).toEqual(
      expect.objectContaining({
        ...(aspectRatio && { aspectRatio }),
        ...(imageSize && { imageSize }),
      }),
    );
  }
}

/**
 * Asserts fetch was called with expected fal API URL and body
 * Preserves exact Authorization header check for API key verification
 */
export function expectFalFetchCall(
  fetchMock: ReturnType<typeof vi.fn>,
  params: {
    call: number;
    url: string;
    body: Record<string, unknown>;
    expectedAuth?: string; // Optional exact auth header value (e.g., "Key fal-test-key")
  },
) {
  const { call, url, body, expectedAuth } = params;

  expect(fetchMock).toHaveBeenNthCalledWith(
    call,
    url,
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: expectedAuth ?? expect.stringMatching(/^Key /),
        "Content-Type": "application/json",
      }),
    }),
  );

  const request = fetchMock.mock.calls[call - 1]?.[1];
  expect(request).toBeTruthy();
  expect(JSON.parse(String(request?.body))).toEqual(body);
}

/**
 * Legacy function for fal JSON post assertions (kept for backward compatibility)
 * Uses exact Authorization header check
 */
export function expectFalJsonPost(
  fetchMock: ReturnType<typeof vi.fn>,
  params: {
    call: number;
    url: string;
    body: Record<string, unknown>;
  },
) {
  const { call, url, body } = params;

  expect(fetchMock).toHaveBeenNthCalledWith(
    call,
    url,
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Key fal-test-key",
        "Content-Type": "application/json",
      }),
    }),
  );

  const request = fetchMock.mock.calls[call - 1]?.[1];
  expect(request).toBeTruthy();
  expect(JSON.parse(String(request?.body))).toEqual(body);
}

/**
 * Asserts image generation result structure
 * Supports optional metadata field for providers that include it
 */
export function expectImageResult(
  result: { images: MockImageResult[]; model: string; metadata?: Record<string, unknown> },
  params: {
    imageData: string;
    mimeType: string;
    model: string;
    fileName?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const { imageData, mimeType, model, fileName, metadata } = params;
  
  const expected: { images: MockImageResult[]; model: string; metadata?: Record<string, unknown> } = {
    images: [
      {
        buffer: Buffer.from(imageData),
        mimeType,
        fileName: fileName || `image-1.${mimeType.split("/")[1]}`,
      },
    ],
    model,
  };
  
  // Only include metadata in expectation if provided
  if (metadata !== undefined) {
    expected.metadata = metadata;
  }
  
  expect(result).toEqual(expected);
}
