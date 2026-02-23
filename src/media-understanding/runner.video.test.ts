import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createMediaAttachmentCache, normalizeMediaAttachments, runCapability } from "./runner.js";

async function withVideoFixture(
  filePrefix: string,
  run: (params: {
    ctx: { MediaPath: string; MediaType: string };
    media: ReturnType<typeof normalizeMediaAttachments>;
    cache: ReturnType<typeof createMediaAttachmentCache>;
  }) => Promise<void>,
) {
  const tmpPath = path.join(os.tmpdir(), `${filePrefix}-${Date.now().toString()}.mp4`);
  await fs.writeFile(tmpPath, Buffer.from("video"));
  const ctx = { MediaPath: tmpPath, MediaType: "video/mp4" };
  const media = normalizeMediaAttachments(ctx);
  const cache = createMediaAttachmentCache(media, {
    localPathRoots: [path.dirname(tmpPath)],
  });
  try {
    await withEnvAsync({ PATH: "" }, async () => {
      await run({ ctx, media, cache });
    });
  } finally {
    await cache.cleanup();
    await fs.unlink(tmpPath).catch(() => {});
  }
}

describe("runCapability video provider wiring", () => {
  it("merges video baseUrl and headers with entry precedence", async () => {
    let seenBaseUrl: string | undefined;
    let seenHeaders: Record<string, string> | undefined;

    await withVideoFixture("openclaw-video-merge", async ({ ctx, media, cache }) => {
      const cfg = {
        models: {
          providers: {
            moonshot: {
              apiKey: "provider-key",
              baseUrl: "https://provider.example/v1",
              headers: { "X-Provider": "1" },
              models: [],
            },
          },
        },
        tools: {
          media: {
            video: {
              enabled: true,
              baseUrl: "https://config.example/v1",
              headers: { "X-Config": "2" },
              models: [
                {
                  provider: "moonshot",
                  model: "kimi-k2.5",
                  baseUrl: "https://entry.example/v1",
                  headers: { "X-Entry": "3" },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = await runCapability({
        capability: "video",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry: new Map([
          [
            "moonshot",
            {
              id: "moonshot",
              capabilities: ["video"],
              describeVideo: async (req) => {
                seenBaseUrl = req.baseUrl;
                seenHeaders = req.headers;
                return { text: "video ok", model: req.model };
              },
            },
          ],
        ]),
      });

      expect(result.outputs[0]?.text).toBe("video ok");
      expect(result.outputs[0]?.provider).toBe("moonshot");
      expect(seenBaseUrl).toBe("https://entry.example/v1");
      expect(seenHeaders).toMatchObject({
        "X-Provider": "1",
        "X-Config": "2",
        "X-Entry": "3",
      });
    });
  });

  it("auto-selects moonshot for video when google is unavailable", async () => {
    await withEnvAsync(
      {
        GEMINI_API_KEY: undefined,
        MOONSHOT_API_KEY: undefined,
      },
      async () => {
        await withVideoFixture("openclaw-video-auto-moonshot", async ({ ctx, media, cache }) => {
          const cfg = {
            models: {
              providers: {
                moonshot: {
                  apiKey: "moonshot-key",
                  models: [],
                },
              },
            },
            tools: {
              media: {
                video: {
                  enabled: true,
                },
              },
            },
          } as unknown as OpenClawConfig;

          const result = await runCapability({
            capability: "video",
            cfg,
            ctx,
            attachments: cache,
            media,
            providerRegistry: new Map([
              [
                "google",
                {
                  id: "google",
                  capabilities: ["video"],
                  describeVideo: async () => ({ text: "google" }),
                },
              ],
              [
                "moonshot",
                {
                  id: "moonshot",
                  capabilities: ["video"],
                  describeVideo: async () => ({ text: "moonshot", model: "kimi-k2.5" }),
                },
              ],
            ]),
          });

          expect(result.decision.outcome).toBe("success");
          expect(result.outputs[0]?.provider).toBe("moonshot");
          expect(result.outputs[0]?.text).toBe("moonshot");
        });
      },
    );
  });
});
