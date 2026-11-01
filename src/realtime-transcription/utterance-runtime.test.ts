import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/capability-provider.types.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import {
  runtimeMediaModelSecretOwnerId,
  runtimeMediaRequestSecretOwnerId,
} from "../secrets/runtime-media-secret-owner.js";
import { transcribeAudioStream } from "./utterance-runtime.js";

const mocks = vi.hoisted(() => ({ getProvider: vi.fn() }));
// mock-isolation: Resolve only synthetic providers; never discover installed plugins or stored credentials.
vi.mock("./provider-registry.js", () => ({ getRealtimeTranscriptionProvider: mocks.getProvider }));
// mock-isolation: provider discovery is fixture-owned; credentials and policy use their real owners.
vi.mock("../media-understanding/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media-understanding/provider-registry.js")>()),
  buildMediaUnderstandingRegistry: () =>
    new Map([
      ["fixture", { id: "fixture", capabilities: ["audio"] }],
      ["second", { id: "second", capabilities: ["audio"] }],
    ]),
}));

const format = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 } as const;
const fixtureCredentials = {
  providers: {
    fixture: { baseUrl: "https://fixture.invalid", apiKey: "synthetic-fixture-key", models: [] },
    second: { baseUrl: "https://second.invalid", apiKey: "synthetic-fixture-key", models: [] },
  },
};
const cfg: OpenClawConfig = {
  models: fixtureCredentials,
  tools: { media: { models: [{ provider: "fixture", model: "stream", capabilities: ["audio"] }] } },
};
function fixture() {
  const session = {
    connect: vi.fn(async () => {}),
    writeAudio: vi.fn(async (_audio: Buffer) => {}),
    finishInput: vi.fn(async () => ({ text: "include the last word" })),
    sendAudio: vi.fn(),
    close: vi.fn(),
    isConnected: () => true,
  };
  const createSession = vi.fn<RealtimeTranscriptionProviderPlugin["createSession"]>(() => session);
  const provider: RealtimeTranscriptionProviderPlugin = {
    id: "fixture",
    label: "Fixture",
    utterance: { formats: [format], models: ["stream"] },
    defaultModel: "stream",
    isConfigured: () => true,
    createSession,
  };
  mocks.getProvider.mockReturnValue(provider);
  return { session, provider, createSession };
}
async function* audio() {
  yield Buffer.alloc(320);
}
const args = () => ({
  cfg,
  agentId: "voice",
  format,
  audio: audio(),
  signal: new AbortController().signal,
});
afterEach(() => {
  setActiveDegradedSecretOwners([]);
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("finite audio streaming runtime", () => {
  it("keeps configured provider/model order and never consumes input for unsupported fallback", async () => {
    const { provider } = fixture();
    const iterator = vi.fn(() => audio());
    const input = { [Symbol.asyncIterator]: iterator };
    mocks.getProvider.mockReturnValue({ ...provider, utterance: undefined });
    const ordered: OpenClawConfig = {
      tools: {
        media: {
          models: [
            { provider: "fixture", model: "stream", capabilities: ["audio"] },
            { provider: "second", model: "stream", capabilities: ["audio"] },
          ],
        },
      },
    };
    expect(await transcribeAudioStream({ ...args(), cfg: ordered, audio: input })).toMatchObject({
      supported: false,
    });
    expect(mocks.getProvider).toHaveBeenCalledOnce();
    expect(mocks.getProvider.mock.calls[0]?.[0]).toBe("fixture");
    expect(iterator).not.toHaveBeenCalled();
    mocks.getProvider.mockReturnValue(provider);
    expect(
      await transcribeAudioStream({
        ...args(),
        audio: input,
        cfg: {
          tools: {
            media: { models: [{ provider: "fixture", model: "batch", capabilities: ["audio"] }] },
          },
        },
      }),
    ).toMatchObject({ supported: false, reason: "selected_model_requires_batch" });
    expect(iterator).not.toHaveBeenCalled();
  });

  it("honors shared preferred-model selection and scope policy", async () => {
    fixture();
    const selected: OpenClawConfig = {
      models: fixtureCredentials,
      tools: {
        media: {
          audio: { preferredModel: "second/stream" },
          models: [
            { provider: "fixture", model: "stream", capabilities: ["audio"] },
            { provider: "second", model: "stream", capabilities: ["audio"] },
          ],
        },
      },
    };
    await transcribeAudioStream({ ...args(), cfg: selected });
    expect(mocks.getProvider.mock.calls[0]?.[0]).toBe("second");
    const blocked: OpenClawConfig = { tools: { media: { audio: { scope: { default: "deny" } } } } };
    await expect(transcribeAudioStream({ ...args(), cfg: blocked })).rejects.toThrow(
      "disabled by policy",
    );
  });

  it("empty input is successful silence without connecting", async () => {
    const { session } = fixture();
    async function* empty() {
      /* no audio */
    }
    expect(await transcribeAudioStream({ ...args(), audio: empty() })).toMatchObject({
      supported: true,
      text: "",
      no_speech: true,
    });
    expect(session.connect).not.toHaveBeenCalled();
    expect(session.finishInput).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("rejects malformed/oversized PCM and never turns a runtime failure into fallback", async () => {
    const { session } = fixture();
    async function* bad() {
      yield Buffer.alloc(3);
    }
    await expect(transcribeAudioStream({ ...args(), audio: bad() })).rejects.toThrow("PCM");
    expect(session.connect).not.toHaveBeenCalled();
    session.finishInput.mockRejectedValue(new Error("provider finalization failed"));
    await expect(transcribeAudioStream(args())).rejects.toThrow("provider finalization failed");
    expect(session.finishInput).toHaveBeenCalledOnce();
  });

  it("abort interrupts a stalled input and fences late frames", async () => {
    const { session } = fixture();
    const controller = new AbortController();
    let read!: () => void;
    const readGate = new Promise<void>((resolve) => {
      read = resolve;
    });
    const iterator = {
      next: vi.fn(() => {
        read();
        return new Promise<IteratorResult<Uint8Array>>(() => {});
      }),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const pending = transcribeAudioStream({
      ...args(),
      signal: controller.signal,
      audio: { [Symbol.asyncIterator]: () => iterator },
    });
    await readGate;
    controller.abort(new Error("canceled"));
    await expect(pending).rejects.toThrow("canceled");
    expect(iterator.return).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
    expect(session.writeAudio).not.toHaveBeenCalled();
  });

  it("deadline cancels a never-finalized utterance and closes the provider", async () => {
    vi.useFakeTimers();
    const { session } = fixture();
    let finishing!: () => void;
    const finishGate = new Promise<void>((resolve) => {
      finishing = resolve;
    });
    session.finishInput.mockImplementation(() => {
      finishing();
      return new Promise(() => {});
    });
    const pending = transcribeAudioStream({ ...args(), timeoutMs: 100 });
    const rejected = expect(pending).rejects.toThrow("timed out");
    await finishGate;
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(session.close).toHaveBeenCalledOnce();
  });

  it.each([
    { model: undefined },
    { profile: "account:fixture" },
    { preferredProfile: "account:fixture" },
    { headers: { "X-Fixture": "value" } },
    { request: { headers: { "X-Fixture": "value" } } },
    { prompt: "preserve spelling" },
    { providerOptions: { fixture: { mode: true } } },
  ])(
    "retains batch selection for unsupported settings %j without consuming input",
    async (overrides) => {
      const { session } = fixture();
      const iterator = vi.fn(() => audio());
      const configured: OpenClawConfig = {
        models: fixtureCredentials,
        tools: {
          media: {
            models: [
              { provider: "fixture", model: "stream", capabilities: ["audio"], ...overrides },
            ],
          },
        },
      };
      await expect(
        transcribeAudioStream({
          ...args(),
          cfg: configured,
          audio: { [Symbol.asyncIterator]: iterator },
        }),
      ).resolves.toMatchObject({ supported: false });
      expect(iterator).not.toHaveBeenCalled();
      expect(session.connect).not.toHaveBeenCalled();
    },
  );

  it("matches scoped channel/key denials before consuming input", async () => {
    fixture();
    const iterator = vi.fn(() => audio());
    const configured: OpenClawConfig = {
      ...cfg,
      tools: {
        media: {
          ...cfg.tools?.media,
          audio: {
            scope: {
              default: "allow",
              rules: [{ action: "deny", match: { channel: "voice", keyPrefix: "agent:kitchen:" } }],
            },
          },
        },
      },
    };
    await expect(
      transcribeAudioStream({
        ...args(),
        cfg: configured,
        scopeContext: { channel: "voice", sessionKey: "agent:kitchen:satellite" },
        audio: { [Symbol.asyncIterator]: iterator },
      }),
    ).rejects.toThrow("disabled by policy");
    expect(iterator).not.toHaveBeenCalled();
  });

  it.each(["model", "request"] as const)(
    "honors degraded %s secret admission before input",
    async (kind) => {
      const { session } = fixture();
      setActiveDegradedSecretOwners([
        {
          ownerKind: "capability",
          state: "unavailable",
          ownerId:
            kind === "model"
              ? runtimeMediaModelSecretOwnerId(0)
              : runtimeMediaRequestSecretOwnerId("audio"),
          paths: [
            kind === "model"
              ? "tools.media.models[0].request.auth.token"
              : "tools.media.audio.request.headers.X-Fixture",
          ],
          refKeys: ["env:default:MISSING_FIXTURE_VALUE"],
          reason: "secret reference was not found",
        },
      ]);
      const iterator = vi.fn(() => audio());
      await expect(
        transcribeAudioStream({ ...args(), audio: { [Symbol.asyncIterator]: iterator } }),
      ).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE" });
      expect(iterator).not.toHaveBeenCalled();
      expect(session.connect).not.toHaveBeenCalled();
    },
  );

  it("honors configured byte and time limits rather than looser caller limits", async () => {
    vi.useFakeTimers();
    const { session } = fixture();
    const configured: OpenClawConfig = {
      ...cfg,
      tools: { media: { ...cfg.tools?.media, audio: { maxBytes: 4, timeoutSeconds: 1 } } },
    };
    await expect(
      transcribeAudioStream({ ...args(), cfg: configured, maxAudioBytes: 8192 }),
    ).rejects.toThrow("PCM");
    expect(session.connect).not.toHaveBeenCalled();
    let finishing!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishing = resolve;
    });
    session.finishInput.mockImplementation(() => {
      finishing();
      return new Promise(() => {});
    });
    const pending = transcribeAudioStream({
      ...args(),
      cfg: configured,
      audio: (async function* () {
        yield Buffer.alloc(4);
      })(),
      timeoutMs: 20000,
    });
    const rejected = expect(pending).rejects.toThrow("timed out");
    await gate;
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
  });
});
