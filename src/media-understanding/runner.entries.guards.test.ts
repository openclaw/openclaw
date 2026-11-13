import { createServer } from "node:http";
import path from "node:path";
import { ok } from "@openclaw/normalization-core/result";
import { afterEach, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveProviderRequestHeaders } from "../agents/provider-request-config.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import {
  runtimeMediaModelSecretOwnerId,
  runtimeMediaRequestSecretOwnerId,
} from "../secrets/runtime-media-secret-owner.js";
import { appendConfigPathSegment } from "../shared/dot-path.js";
import { buildMediaUnderstandingRegistry } from "./provider-registry.js";
import type { MediaUnderstandingProvider } from "./provider-types.js";
import { runProviderEntry } from "./runner.entries.js";
import { withAudioFixture, withMediaFixture } from "./runner.test-utils.js";

afterEach(() => setActiveDegradedSecretOwners([]));

function markUnavailable(ownerId: string, configPath: string) {
  setActiveDegradedSecretOwners([
    {
      ownerKind: "capability",
      ownerId,
      state: "unavailable",
      paths: [configPath],
      refKeys: ["env:default:MISSING_MEDIA_VALUE"],
      reason: "secret reference was not found",
    },
  ]);
}

type RunProviderEntryParams = Parameters<typeof runProviderEntry>[0];
function runAudio(overrides: Partial<RunProviderEntryParams>) {
  return runProviderEntry({
    capability: "audio",
    entry: { provider: "fixture", model: "fixture-audio" },
    cfg: {},
    attachmentIndex: 0,
    cache: {} as RunProviderEntryParams["cache"],
    providerRegistry: new Map(),
    ...overrides,
  });
}

const providerConfig = { apiKey: "fixture-key", baseUrl: "https://fixture.example/v1", models: [] };
const fixtureConfig = { models: { providers: { fixture: providerConfig } } };
function audioProvider(
  callbacks: Pick<MediaUnderstandingProvider, "transcribeAudio" | "transcribeAudioWithContext">,
) {
  return new Map<string, MediaUnderstandingProvider>([
    ["fixture", { id: "fixture", capabilities: ["audio"], ...callbacks }],
  ]);
}

it.each(["provider capture prep", "DNS resolution"] as const)(
  "rechecks request authority after %s before upload",
  async (revokeAt) => {
    await withAudioFixture("openclaw-audio-authority", async ({ cache }) => {
      const paused = createDeferred();
      const resume = createDeferred();
      const pauseAt = async (stage: typeof revokeAt) => {
        if (revokeAt === stage) {
          paused.resolve();
          await resume.promise;
        }
      };
      let admitted = true;
      const assertCurrent = () => {
        if (!admitted) {
          throw new Error("admission expired");
        }
      };
      const fetchImpl = vi.fn(async () => new Response("uploaded"));
      const transcribeAudioWithContext = vi.fn(async () => {
        await pauseAt("provider capture prep");
        await fetchWithSsrFGuard({
          url: "https://public.example/audio",
          fetchImpl,
          lookupFn: async () => {
            await pauseAt("DNS resolution");
            return [{ address: "93.184.216.34", family: 4 }];
          },
        });
        return ok({ text: "must not upload" });
      });
      const run = runAudio({
        cfg: fixtureConfig,
        cache,
        providerRegistry: audioProvider({ transcribeAudioWithContext }),
        assertCurrent,
      });

      await paused.promise;
      admitted = false;
      resume.resolve();
      await expect(run).rejects.toThrow("admission expired");
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  },
);

it("rechecks admission after attachment/auth preparation", async () => {
  await withAudioFixture("openclaw-admission-provider", async ({ cache }) => {
    const transcribeAudio = vi.fn(async () => ({ text: "must not upload" }));
    const assertCurrent = vi.fn(() => {
      throw new Error("admission expired");
    });
    const result = runAudio({
      cfg: fixtureConfig,
      cache,
      providerRegistry: audioProvider({ transcribeAudio }),
      assertCurrent,
    });

    await expect(result).rejects.toThrow("admission expired");
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(transcribeAudio).not.toHaveBeenCalled();
  });
});

it.each(["audio", "image"] as const)(
  "sends %s and credentials only to the selected provider",
  async (capability) => {
    function receiver() {
      const received: Array<{ auth?: string; provider?: string | string[]; body: Buffer }> = [];
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        received.push({
          auth: request.headers.authorization,
          provider: request.headers["x-fixture-provider"],
          body: Buffer.concat(chunks),
        });
        response.end("transcribed");
      });
      return { received, server };
    }

    const google = receiver();
    const gemini = receiver();
    const googleUrl = await listenLoopback(google.server);
    const geminiUrl = await listenLoopback(gemini.server);
    try {
      const upload = async (
        id: string,
        baseUrl: string | undefined,
        apiKey: string,
        buffer: Buffer,
      ) => {
        if (!baseUrl) {
          throw new Error("No test receiver URL");
        }
        const response = await fetch(baseUrl, {
          method: "POST",
          body: new Uint8Array(buffer),
          headers: { authorization: `Bearer ${apiKey}`, "x-fixture-provider": id },
        });
        return { text: await response.text() };
      };
      const buildProvider = (id: string): MediaUnderstandingProvider => ({
        id,
        capabilities: [capability],
        transcribeAudio: ({ apiKey, baseUrl, buffer }) => upload(id, baseUrl, apiKey, buffer),
        describeImage: ({ cfg, provider, buffer }) => {
          const config = cfg.models?.providers?.[provider];
          if (!config || typeof config.apiKey !== "string") {
            throw new Error("No test receiver credentials");
          }
          return upload(id, config.baseUrl, config.apiKey, buffer);
        },
      });
      const cfg = {
        models: {
          providers: {
            google: { apiKey: "google-fixture", baseUrl: googleUrl, models: [] },
            gemini: { apiKey: "gemini-fixture", baseUrl: geminiUrl, models: [] },
          },
        },
      };
      const png = createSolidPngBuffer(8, 8, { r: 24, g: 96, b: 208 });
      const runFixture: Parameters<typeof withMediaFixture>[1] = async ({ cache, mediaPath }) => {
        const entry = { provider: " Gemini ", model: "fixture-model" };
        const googleProvider = buildProvider("google");
        const geminiProvider = buildProvider("gemini");
        const providerRegistry = buildMediaUnderstandingRegistry(undefined, cfg, [
          googleProvider,
          geminiProvider,
        ]);
        const expectedBody = (
          await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024 * 1024, timeoutMs: 10_000 })
        ).buffer;
        const run = () =>
          runProviderEntry({
            capability,
            cfg,
            cache,
            entry,
            providerRegistry,
            attachmentIndex: 0,
            agentDir: path.dirname(mediaPath),
          });
        const expectGemini = async () => {
          await expect(run()).resolves.toMatchObject({ ok: true, value: { provider: "gemini" } });
        };

        await expectGemini();
        providerRegistry.delete("google");
        await expectGemini();
        expect(google.received).toEqual([]);
        const geminiRequest = {
          auth: "Bearer gemini-fixture",
          provider: "gemini",
          body: expectedBody,
        };
        expect(gemini.received).toEqual([geminiRequest, geminiRequest]);

        providerRegistry.delete("gemini");
        providerRegistry.set("google", googleProvider);
        await expect(run()).resolves.toMatchObject({ ok: true, value: { provider: "google" } });
        expect(google.received).toEqual([
          { auth: "Bearer google-fixture", provider: "google", body: expectedBody },
        ]);
        expect(gemini.received).toEqual([geminiRequest, geminiRequest]);
      };
      if (capability === "audio") {
        await withAudioFixture("openclaw-media-provider-owner", runFixture);
      } else {
        await withMediaFixture(
          {
            filePrefix: "openclaw-media-provider-owner",
            extension: "png",
            mediaType: "image/png",
            fileContents: png,
          },
          runFixture,
        );
      }
    } finally {
      await Promise.all([closeHttpServer(google.server), closeHttpServer(gemini.server)]);
    }
  },
);

it("includes the catalog repair hint for a media provider contract", async () => {
  await expect(runAudio({ entry: { provider: "groq" } })).rejects.toThrow(
    /Media provider not available: groq .*openclaw plugins install .*@openclaw\/groq-provider.*openclaw plugins registry --refresh.*stop and start the gateway service.*openclaw doctor --fix/,
  );
});

it.each([
  ["X.Trace", undefined],
  ["X.Trace", "x.trace"],
  ["constructor", "constructor"],
] as const)("isolates unavailable header %s with override %s", async (sharedHeader, headerName) => {
  const ownerId = runtimeMediaRequestSecretOwnerId("audio");
  markUnavailable(
    ownerId,
    appendConfigPathSegment("tools.media.audio.request.headers", sharedHeader),
  );
  await withAudioFixture("openclaw-media-header-owner", async ({ cache }) => {
    const transcribeAudioWithContext = vi.fn<
      NonNullable<MediaUnderstandingProvider["transcribeAudioWithContext"]>
    >(async () => ok({ text: "transcribed" }));
    const result = runAudio({
      entry: {
        provider: "fixture",
        model: "audio-fixture",
        request: headerName ? { headers: { [headerName]: "healthy-header" } } : undefined,
      },
      config: { request: { headers: {} } },
      cache,
      providerRegistry: audioProvider({ transcribeAudioWithContext }),
    });
    if (headerName) {
      await expect(result).resolves.toMatchObject({ ok: true, value: { text: "transcribed" } });
      expect(transcribeAudioWithContext).toHaveBeenCalledOnce();
      const request = transcribeAudioWithContext.mock.calls[0]![0].request;
      const headers = { [headerName]: "healthy-header" };
      expect(request?.headers).toEqual(headers);
      expect(resolveProviderRequestHeaders({ provider: "fixture", request })).toEqual(
        sharedHeader === "constructor" ? undefined : headers,
      );
    } else {
      await expect(result).rejects.toMatchObject({
        code: "SECRET_SURFACE_UNAVAILABLE",
        ownerId,
      });
      expect(transcribeAudioWithContext).not.toHaveBeenCalled();
    }
  });
});

it.each([false, true])(
  "requires an override for unavailable model fields: %s",
  async (override) => {
    const ownerId = override
      ? runtimeMediaRequestSecretOwnerId("audio")
      : runtimeMediaModelSecretOwnerId(0);
    const entry: RunProviderEntryParams["entry"] = {
      provider: override ? "unknown-provider" : "openai",
      capabilities: ["audio"],
      request: override
        ? { auth: { mode: "authorization-bearer", token: "test-token" } }
        : undefined,
    };
    const cfg = { tools: { media: { models: [entry], audio: {} } } };
    markUnavailable(
      ownerId,
      `${override ? "tools.media.audio" : "tools.media.models.0"}.request.auth.token`,
    );
    const result = runAudio({
      entry,
      cfg,
      config: cfg.tools.media.audio,
      secretOwnerId: override ? undefined : ownerId,
    });
    if (override) {
      await expect(result).rejects.toThrow("Media provider not available: unknown-provider");
    } else {
      await expect(result).rejects.toMatchObject({
        code: "SECRET_SURFACE_UNAVAILABLE",
        ownerKind: "capability",
        ownerId,
      });
    }
  },
);
