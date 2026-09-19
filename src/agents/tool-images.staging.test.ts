// Tool image staging tests cover the managed media reference an explicitly presentable
// inline image carries, so the chat display projection renders the image instead of a
// non-recoverable "omitted from history" placeholder, and cover the inverse: an
// inspection-only result never reaches the shared store.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeChatHistoryContentBlock } from "../gateway/chat-display-projection.sanitize.js";
import type { ImageContent } from "../llm/types.js";
import { resolveInboundMediaOwnership } from "../media/inbound-media-ownership.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import type { AgentToolResult } from "./runtime/index.js";
import { sanitizeToolResultImages } from "./tool-images.js";

// 64x64 opaque PNG: valid, small, and far under the resize thresholds, so the
// sanitizer stages these exact bytes.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmElEQVR4nO3QMREAIBDAsHeERQyjAWRkoEP2Xmftc382OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0B06OyaOxP7RwAAAAASUVORK5CYII=";

const imageBlock = (): ImageContent => ({
  type: "image",
  data: PNG_BASE64,
  mimeType: "image/png",
});

/** The explicit presentation decision publication requires; production callers omit it. */
const PRESENTABLE_DETAILS = { media: { present: true } };

/** Stages one block the way a tool result does, so these cases exercise the real path. */
async function stageViaToolResult(
  block: ImageContent,
  details: unknown = PRESENTABLE_DETAILS,
): Promise<unknown> {
  const result = await sanitizeToolResultImages({ content: [block], details }, "image:native");
  return result.content[0];
}

async function storedInboundEntries(stateDir: string): Promise<string[]> {
  return await fs.readdir(path.join(stateDir, "media", "inbound")).catch(() => []);
}

async function withMediaStore(run: (stateDir: string) => Promise<void>): Promise<void> {
  const env = captureEnv(["OPENCLAW_STATE_DIR"]);
  try {
    await withTestDir({ prefix: "openclaw-inline-image-staging-" }, async (stateDir) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      await run(stateDir);
    });
  } finally {
    env.restore();
  }
}

describe("inline image staging", () => {
  it("publishes an explicitly presentable image so the display projection keeps a reference", async () => {
    await withMediaStore(async (stateDir) => {
      const staged = (await stageViaToolResult(imageBlock())) as ImageContent;
      expect(staged.type).toBe("image");
      expect(staged.url).toMatch(/^media:\/\/inbound\/[A-Za-z0-9._-]+$/u);

      // The reference resolves to the stored bytes, and only inside the store.
      const id = decodeURIComponent(new URL(String(staged.url)).pathname.replace(/^\/+/u, ""));
      const stored = await fs.readFile(path.join(stateDir, "media", "inbound", id));
      expect(stored.equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);

      // The model payload survives, because provider hydration reads it.
      expect(Buffer.from(staged.data, "base64").equals(stored)).toBe(true);

      // The object is session-bound from the moment it is published, so the route can
      // refuse it to a request that names no session, even before the result lands in one.
      const ownership = await resolveInboundMediaOwnership(id);
      expect(ownership?.stagedAt).toEqual(expect.any(Number));
      expect(ownership?.sessionKey).toBeUndefined();

      // Display projection: the reference is kept, the private payload dropped, and the
      // block is not marked omitted, because omission means the media is gone rather
      // than that its inline payload was stripped.
      const projected = sanitizeChatHistoryContentBlock(staged).block as Record<string, unknown>;
      expect(projected.url).toBe(staged.url);
      expect(projected.omitted).toBeUndefined();
      expect(projected.data).toBeUndefined();
      expect(JSON.stringify(projected)).not.toContain(stateDir);
    });
  });

  it("stages a block once, keeping the same reference and one store entry", async () => {
    await withMediaStore(async (stateDir) => {
      const first = (await stageViaToolResult(imageBlock())) as ImageContent;
      expect(first.url).toMatch(/^media:\/\/inbound\//u);
      const second = (await stageViaToolResult(first)) as ImageContent;
      expect(second.url).toBe(first.url);
      expect(await storedInboundEntries(stateDir)).toHaveLength(1);
    });
  });

  it("leaves a block that already carries a reference alone", async () => {
    await withMediaStore(async (stateDir) => {
      const staged = (await stageViaToolResult({
        ...imageBlock(),
        url: "https://files.example/kept.png",
      })) as ImageContent;
      expect(staged.url).toBe("https://files.example/kept.png");
      expect(await storedInboundEntries(stateDir)).toEqual([]);
    });
  });

  it("writes nothing for a payload that cannot be staged", async () => {
    await withMediaStore(async (stateDir) => {
      const staged = (await stageViaToolResult({
        type: "image",
        data: "not base64",
        mimeType: "image/png",
      })) as Record<string, unknown>;
      expect(staged.type).toBe("text");
      expect(staged.url).toBeUndefined();
      expect(await storedInboundEntries(stateDir)).toEqual([]);
    });
  });

  // The shipped inspection contract: a native vision result marks media.outbound false,
  // the shared read tool and private reads carry no decision at all, and none of them may
  // copy bytes into storage the media route serves.
  it.each([
    ["no presentation decision", {}],
    ["native inspection", { media: { outbound: false } }],
    ["an explicit refusal", { media: { present: false } }],
    ["no details at all", undefined],
  ])("keeps an inspection-only result private with %s", async (_name, details) => {
    await withMediaStore(async (stateDir) => {
      const block = imageBlock();
      // A result without a presentation decision omits details entirely; the staging
      // helper's default argument supplies the presentable decision, so an absent
      // `details` and `details: undefined` resolve identically to inspection-only.
      const result: AgentToolResult<unknown> =
        details === undefined
          ? { content: [block], details: undefined }
          : { content: [block], details };
      const staged = (await sanitizeToolResultImages(result, "image:native").then(
        (sanitized) => sanitized.content[0],
      )) as ImageContent;

      expect(staged.url).toBeUndefined();
      expect(staged.data).toBe(PNG_BASE64);
      expect(await storedInboundEntries(stateDir)).toEqual([]);

      // The projection still protects the private payload, so nothing about the
      // inspection path changed.
      const projected = sanitizeChatHistoryContentBlock(staged).block as Record<string, unknown>;
      expect(projected.url).toBeUndefined();
      expect(projected.data).toBeUndefined();
      expect(projected.omitted).toBe(true);
    });
  });
});
