import fs from "node:fs/promises";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it as baseIt,
  onTestFinished,
  vi,
  type MockInstance,
} from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { toInboundMediaFacts } from "../channels/inbound-event/media.js";
import type { OpenClawConfig } from "../config/types.js";
import { saveMediaBuffer } from "../media/store.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { applyMediaUnderstanding } from "./apply.js";
import { MediaAttachmentCache } from "./attachments.js";
import { normalizeMediaAttachments } from "./runner.attachments.js";
import { formatDecisionSummary } from "./runner.entries.js";
import { runCapability } from "./runner.js";
import { createSafeAudioFixtureBuffer } from "./runner.test-utils.js";
import type { AudioTranscriptionRequest, MediaUnderstandingProvider } from "./types.js";

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

const it = baseIt.extend<{ stateDir: string; saved: { id: string; path: string } }>({
  stateDir: async ({ task: _task }, use) => {
    await withTestDir({ prefix: "openclaw-media-store-ref-" }, (stateDir) =>
      withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, PATH: "" }, () => use(stateDir)),
    );
  },
  saved: async ({ stateDir: _stateDir }, use) => {
    await use(
      await saveMediaBuffer(createSafeAudioFixtureBuffer(2048, 0x52), "audio/ogg", "inbound"),
    );
  },
});
let fetchSpy: MockInstance<typeof fetch>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => fetchSpy.mockRestore());
function documentContext(url: string, contentType: string): MsgContext {
  return {
    Body: "<media:document>",
    media: toInboundMediaFacts([{ url, contentType, kind: "document" }]),
  };
}

const audioCfg = {
  models: { providers: { openai: { apiKey: "test-key", models: [] } } },
} as unknown as OpenClawConfig;
const urlDisabledFileCfg: OpenClawConfig = {
  tools: {
    media: {
      audio: { enabled: false },
      image: { enabled: false },
      video: { enabled: false },
    },
  },
  gateway: { http: { endpoints: { responses: { files: { allowUrl: false } } } } },
};

const request = { attachmentIndex: 0, maxBytes: 4096, timeoutMs: 1000 };
function storedCache(saved: { id: string; path: string }, sourcePath: string) {
  const cache = new MediaAttachmentCache(
    [{ index: 0, path: sourcePath, url: `media://inbound/${saved.id}`, mime: "audio/ogg" }],
    {
      localPathRoots: [path.dirname(saved.path)],
      includeDefaultLocalPathRoots: false,
    },
  );
  onTestFinished(() => cache.cleanup());
  return cache;
}

describe("inbound media-store references in the attachment url field", () => {
  it("extracts a stored document when remote URLs are disabled", async ({
    stateDir: _stateDir,
  }) => {
    const saved = await saveMediaBuffer(
      Buffer.from("stored document text"),
      "text/plain",
      "inbound",
    );
    const ctx = documentContext(`media://inbound/${saved.id}`, "text/plain");
    await applyMediaUnderstanding({ ctx, cfg: urlDisabledFileCfg });
    expect(ctx.Body).toContain("stored document text");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never renders signed URL query credentials as attachment names", async () => {
    const ctx = documentContext(
      "https://cdn.example.test/docs/report.docx?X-Amz-Signature=SECRETSIG&X-Amz-Credential=AKIA123",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    await applyMediaUnderstanding({ ctx, cfg: urlDisabledFileCfg });
    expect(ctx.Body).toContain("[Attachment skipped: URL file sources are disabled]");
    expect(ctx.Body).toContain('name="report.docx"');
    expect(ctx.Body).not.toContain("SECRETSIG");
    expect(ctx.Body).not.toContain("AKIA123");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("prefers the media:// alias when the supplied path is blocked", async ({
    saved,
    stateDir,
  }) => {
    const blockedPath = path.join(stateDir, "blocked.ogg");
    await fs.writeFile(blockedPath, "blocked");
    const transcribeAudio = vi.fn(async (req: AudioTranscriptionRequest) => ({
      text: "hello from the voice note",
      model: req.model ?? "unknown",
    }));
    const ctx = {
      media: toInboundMediaFacts([
        { path: blockedPath, url: `media://inbound/${saved.id}`, contentType: "audio/ogg" },
      ]),
    };
    const media = normalizeMediaAttachments(ctx);
    const cache = storedCache(saved, blockedPath);
    const providerRegistry = new Map<string, MediaUnderstandingProvider>([
      ["openai", { id: "openai", capabilities: ["audio"], transcribeAudio }],
    ]);
    try {
      const result = await runCapability({
        capability: "audio",
        cfg: audioCfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });
      expect(result).toMatchObject({
        decision: { outcome: "success" },
        outputs: [expect.objectContaining({ text: "hello from the voice note" })],
      });
      expect(transcribeAudio).toHaveBeenCalledTimes(1);
      expect(transcribeAudio.mock.calls[0]?.[0].buffer).toEqual(
        createSafeAudioFixtureBuffer(2048, 0x52),
      );
      expect(formatDecisionSummary(result.decision)).toBe(
        "audio: success (1/1) via openai/gpt-4o-transcribe",
      );
    } finally {
      await cache.cleanup();
    }
  });

  it("returns the stored path after a stale path fails", async ({ saved }) => {
    const cache = storedCache(saved, `${saved.path}.missing`);
    expect(await cache.getPath(request)).toBe(await fs.realpath(saved.path));
    await cache.cleanup();
    expect((await fs.stat(saved.path)).isFile()).toBe(true);
  });

  it("does not bypass a path maxBytes failure through the media:// alias", async ({ saved }) => {
    const oversizedPath = path.join(path.dirname(saved.path), "oversized.ogg");
    await fs.writeFile(oversizedPath, createSafeAudioFixtureBuffer(8192, 0x41));
    const cache = storedCache(saved, oversizedPath);
    await expect(cache.getBuffer(request)).rejects.toMatchObject({ reason: "maxBytes" });
    await cache.cleanup();
  });

  it("rejects malformed media:// aliases without attempting a remote fetch", async () => {
    const cache = new MediaAttachmentCache([{ index: 0, url: "media://inbound/%" }]);

    await expect(cache.getBuffer(request)).rejects.toMatchObject({ reason: "empty" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
