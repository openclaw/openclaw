import { ok } from "@openclaw/normalization-core/result";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProviderRequestHeaders } from "../agents/provider-request-config.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import {
  runtimeMediaModelSecretOwnerId,
  runtimeMediaRequestSecretOwnerId,
} from "../secrets/runtime-media-secret-owner.js";
import { appendConfigPathSegment } from "../shared/dot-path.js";
import { formatDecisionSummary, runProviderEntry } from "./runner.entries.js";
import { withAudioFixture } from "./runner.test-utils.js";
import type { MediaUnderstandingDecision, MediaUnderstandingProvider } from "./types.js";

afterEach(() => {
  setActiveDegradedSecretOwners([]);
});

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

describe("media-understanding formatDecisionSummary guards", () => {
  it("formats skipped summary when decision.attachments is undefined", () => {
    expect(
      formatDecisionSummary({
        capability: "image",
        outcome: "skipped",
        attachments: undefined as unknown as MediaUnderstandingDecision["attachments"],
        attachmentDispositions: {},
        nativeVisionActive: false,
      }),
    ).toBe("image: skipped");
  });

  it("counts malformed attachment attempts as unchosen", () => {
    expect(
      formatDecisionSummary({
        capability: "video",
        outcome: "skipped",
        attachments: [
          {
            attachmentIndex: 0,
            attempts: { bad: true },
            chosen: { outcome: "failed", provider: { bad: true }, model: 42 },
          },
        ],
      } as unknown as MediaUnderstandingDecision),
    ).toBe("video: skipped (0/1)");
  });
});

function missingProvider(provider: string) {
  type RunProviderEntryParams = Parameters<typeof runProviderEntry>[0];
  return runProviderEntry({
    capability: "audio",
    entry: { provider },
    cfg: {},
    attachmentIndex: 0,
    cache: {} as RunProviderEntryParams["cache"],
    providerRegistry: new Map(),
  });
}

describe("media-understanding missing provider errors", () => {
  it("includes the catalog repair hint for a media provider contract", async () => {
    await expect(missingProvider("groq")).rejects.toThrow(
      /Media provider not available: groq .*openclaw plugins install .*@openclaw\/groq-provider.*openclaw plugins registry --refresh.*stop and start the gateway service.*openclaw doctor --fix/,
    );
  });

  it("keeps the legacy error for providers without a media contract", async () => {
    await expect(missingProvider("mystery-provider")).rejects.toThrow(
      "Media provider not available: mystery-provider",
    );
  });
});

describe("media-understanding SecretRef owner isolation", () => {
  it.each([
    { sharedHeader: "X.Trace", headerName: undefined },
    { sharedHeader: "X.Trace", headerName: "x.trace" },
    { sharedHeader: "constructor", headerName: "constructor" },
  ])(
    "isolates the unavailable shared $sharedHeader header with model override $headerName",
    async ({ sharedHeader, headerName }) => {
      const ownerId = runtimeMediaRequestSecretOwnerId("audio");
      markUnavailable(
        ownerId,
        appendConfigPathSegment("tools.media.audio.request.headers", sharedHeader),
      );
      await withAudioFixture("openclaw-media-header-owner", async ({ cache }) => {
        const transcribeAudioWithContext = vi.fn<
          NonNullable<MediaUnderstandingProvider["transcribeAudioWithContext"]>
        >(async (request) => {
          const headers = resolveProviderRequestHeaders({
            provider: "fixture",
            request: request.request,
          });
          expect(headers).toEqual(
            headerName && sharedHeader !== "constructor"
              ? { [headerName]: "healthy-header" }
              : undefined,
          );
          return ok({ text: "transcribed" });
        });
        const result = runProviderEntry({
          capability: "audio",
          entry: {
            provider: "fixture",
            model: "audio-fixture",
            request: headerName ? { headers: { [headerName]: "healthy-header" } } : undefined,
          },
          cfg: {},
          config: { request: { headers: {} } },
          attachmentIndex: 0,
          cache,
          providerRegistry: new Map([
            ["fixture", { id: "fixture", capabilities: ["audio"], transcribeAudioWithContext }],
          ]),
        });
        if (headerName) {
          await expect(result).resolves.toMatchObject({ ok: true, value: { text: "transcribed" } });
          expect(transcribeAudioWithContext).toHaveBeenCalledOnce();
          expect(transcribeAudioWithContext.mock.calls[0]?.[0].request?.headers).toEqual({
            [headerName]: "healthy-header",
          });
        } else {
          await expect(result).rejects.toMatchObject({
            code: "SECRET_SURFACE_UNAVAILABLE",
            ownerId,
          });
          expect(transcribeAudioWithContext).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("rejects only the configured media model whose owner is unavailable", async () => {
    const entry = { provider: "openai", capabilities: ["audio" as const] };
    const cfg = { tools: { media: { models: [entry], audio: {} } } };
    const ownerId = runtimeMediaModelSecretOwnerId(0);
    markUnavailable(ownerId, "tools.media.models.0.request.auth.token");

    type RunProviderEntryParams = Parameters<typeof runProviderEntry>[0];
    await expect(
      runProviderEntry({
        capability: "audio",
        entry,
        cfg,
        config: cfg.tools.media.audio,
        secretOwnerId: ownerId,
        attachmentIndex: 0,
        cache: {} as RunProviderEntryParams["cache"],
        providerRegistry: new Map(),
      }),
    ).rejects.toMatchObject({
      code: "SECRET_SURFACE_UNAVAILABLE",
      ownerKind: "capability",
      ownerId,
    });
  });

  it("keeps a model active when it overrides the unavailable request field", async () => {
    const entry = {
      provider: "unknown-provider",
      capabilities: ["audio" as const],
      request: { auth: { mode: "authorization-bearer" as const, token: "test-token" } },
    };
    const cfg = { tools: { media: { models: [entry], audio: {} } } };
    markUnavailable(
      runtimeMediaRequestSecretOwnerId("audio"),
      "tools.media.audio.request.auth.token",
    );

    type RunProviderEntryParams = Parameters<typeof runProviderEntry>[0];
    await expect(
      runProviderEntry({
        capability: "audio",
        entry,
        cfg,
        config: cfg.tools.media.audio,
        attachmentIndex: 0,
        cache: {} as RunProviderEntryParams["cache"],
        providerRegistry: new Map(),
      }),
    ).rejects.toThrow("Media provider not available: unknown-provider");
  });
});
