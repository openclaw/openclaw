import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { withServer, withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  createTalkFileTranscriptionSession,
  resolveTalkFileTranscriptionConfig,
} from "./file-transcription.js";

describe("Talk ClawRouter file transcription", () => {
  it("delivers a transcript through registered media transcription and real multipart HTTP", async () => {
    await withTempHome(
      async () => {
        const requests: { url?: string; authorization?: string; form: FormData }[] = [];
        await withServer(
          (req, res) => {
            void (async () => {
              const chunks: Buffer[] = [];
              for await (const chunk of req) {
                chunks.push(Buffer.from(chunk));
              }
              const form = await new Response(Buffer.concat(chunks), {
                headers: { "content-type": req.headers["content-type"] ?? "" },
              }).formData();
              requests.push({ url: req.url, authorization: req.headers.authorization, form });
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ text: "synthetic transcript" }));
            })().catch((error: unknown) =>
              res.destroy(error instanceof Error ? error : new Error(String(error))),
            );
          },
          async (baseUrl) => {
            const cfg: OpenClawConfig = {
              plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
              models: {
                providers: {
                  clawrouter: {
                    baseUrl,
                    apiKey: "fixture-router",
                    request: { allowPrivateNetwork: true },
                    models: [],
                  },
                },
              },
              tools: {
                media: {
                  models: [{ provider: "clawrouter", capabilities: ["audio"] }],
                  audio: { enabled: true },
                },
              },
            };
            const config = await resolveTalkFileTranscriptionConfig(cfg);
            expect(config?.ready).toBe(true);
            expect(config?.provider).toBe("clawrouter");
            if (!config) {
              throw new Error("Talk file transcription unavailable");
            }
            const transcripts: string[] = [];
            const session = createTalkFileTranscriptionSession(
              config,
              {
                onTranscript: (text) => {
                  transcripts.push(text);
                },
              },
              () => {},
            );
            try {
              await session.connect();
              session.sendAudio(Buffer.alloc(1600, 0xff));
              await session.finish();
            } finally {
              session.close();
            }
            expect(transcripts).toEqual(["synthetic transcript"]);
            expect(requests).toHaveLength(1);
            expect(requests[0]).toMatchObject({
              url: "/v1/native/openai/v1/audio/transcriptions",
              authorization: "Bearer fixture-router",
            });
            const form = requests[0]!.form;
            expect(form.get("model")).toBe("gpt-4o-transcribe");
            const file = form.get("file") as File;
            expect(file.name).toBe("speech.wav");
            const wav = Buffer.from(await file.arrayBuffer());
            expect(wav.subarray(0, 4).toString()).toBe("RIFF");
            expect(wav.subarray(8, 12).toString()).toBe("WAVE");
            expect(wav.length).toBe(44 + 1600 * 2);
            expect(wav.subarray(44)).toEqual(Buffer.alloc(1600 * 2));
          },
        );
      },
      { env: { CLAWROUTER_API_KEY: undefined, OPENAI_API_KEY: "fixture-upstream-never-router" } },
    );
  });
});
