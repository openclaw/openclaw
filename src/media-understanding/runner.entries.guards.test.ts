import { ok } from "@openclaw/normalization-core/result";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveProviderRequestHeaders } from "../agents/provider-request-config.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import {
  runtimeMediaModelSecretOwnerId,
  runtimeMediaRequestSecretOwnerId,
} from "../secrets/runtime-media-secret-owner.js";
import { appendConfigPathSegment } from "../shared/dot-path.js";
import { runProviderEntry } from "./runner.entries.js";
import { withAudioFixture } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

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
