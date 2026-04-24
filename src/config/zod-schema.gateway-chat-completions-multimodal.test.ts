import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema gateway.http.endpoints.chatCompletions multimodal validation", () => {
  it("accepts audio and files blocks alongside existing image limits", () => {
    expect(() =>
      OpenClawSchema.parse({
        gateway: {
          http: {
            endpoints: {
              chatCompletions: {
                enabled: true,
                maxBodyBytes: 20_971_520,
                maxImageParts: 8,
                maxTotalImageBytes: 20_971_520,
                images: { allowUrl: false, maxBytes: 10_485_760 },
                audio: {
                  enabled: true,
                  maxParts: 4,
                  maxBytes: 26_214_400,
                  maxTotalBytes: 52_428_800,
                  allowedMimes: ["audio/mpeg", "audio/wav"],
                },
                files: {
                  enabled: true,
                  maxParts: 5,
                  allowedMimes: ["text/plain", "application/pdf"],
                  maxBytes: 20_971_520,
                  maxTotalBytes: 52_428_800,
                  maxChars: 200_000,
                  pdf: { maxPages: 4, maxPixels: 4_000_000, minTextChars: 200 },
                },
              },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts the minimal audio.enabled / files.enabled toggle shape", () => {
    expect(() =>
      OpenClawSchema.parse({
        gateway: {
          http: {
            endpoints: {
              chatCompletions: {
                enabled: true,
                audio: { enabled: false },
                files: { enabled: false },
              },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects unknown keys inside chatCompletions.audio", () => {
    expect(() =>
      OpenClawSchema.parse({
        gateway: {
          http: {
            endpoints: {
              chatCompletions: {
                audio: { unknownField: true },
              },
            },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects unknown keys inside chatCompletions.files", () => {
    expect(() =>
      OpenClawSchema.parse({
        gateway: {
          http: {
            endpoints: {
              chatCompletions: {
                files: { unknownField: true },
              },
            },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects URL-fetch keys on chatCompletions.files (runtime does not fetch URLs here)", () => {
    // chatCompletions `file` parts are always base64-encoded; the URL-fetch
    // fields that exist on /v1/responses input_file config are intentionally
    // absent here to avoid surfacing operator knobs that have no effect.
    const deadValues: Record<string, unknown> = {
      allowUrl: true,
      urlAllowlist: ["*.example.com"],
      maxRedirects: 3,
      timeoutMs: 10_000,
    };
    for (const [deadField, value] of Object.entries(deadValues)) {
      expect(() =>
        OpenClawSchema.parse({
          gateway: {
            http: {
              endpoints: {
                chatCompletions: {
                  files: { [deadField]: value },
                },
              },
            },
          },
        }),
      ).toThrow();
    }
  });

  it("rejects non-positive numeric limits on audio/files", () => {
    expect(() =>
      OpenClawSchema.parse({
        gateway: {
          http: {
            endpoints: {
              chatCompletions: {
                audio: { maxBytes: 0 },
              },
            },
          },
        },
      }),
    ).toThrow();

    expect(() =>
      OpenClawSchema.parse({
        gateway: {
          http: {
            endpoints: {
              chatCompletions: {
                files: { maxParts: -1 },
              },
            },
          },
        },
      }),
    ).toThrow();
  });
});
