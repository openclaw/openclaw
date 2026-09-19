// Inbound media ownership tests cover the binding the assistant media route enforces:
// a staged object is bound from the moment it is published, and the session that
// persists the reference becomes its owner.
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  collectInboundMediaIds,
  inboundMediaIdFromReference,
  isSafeInboundMediaId,
  recordInboundMediaOwner,
  recordInboundMediaOwnersInValue,
  recordStagedInboundMedia,
  resolveInboundMediaOwnership,
} from "./inbound-media-ownership.js";

async function withStateDir(run: () => Promise<void>): Promise<void> {
  const env = captureEnv(["OPENCLAW_STATE_DIR"]);
  try {
    await withTestDir({ prefix: "openclaw-inbound-ownership-" }, async (stateDir) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      await run();
    });
  } finally {
    env.restore();
  }
}

describe("inbound media ownership", () => {
  it("marks a staged object before any session is known", async () => {
    await withStateDir(async () => {
      expect(await recordStagedInboundMedia("staged-one.png")).toBe(true);
      const ownership = await resolveInboundMediaOwnership("staged-one.png");
      expect(ownership?.stagedAt).toEqual(expect.any(Number));
      expect(ownership?.sessionKey).toBeUndefined();
    });
  });

  it("binds the owner session and keeps the staged time", async () => {
    await withStateDir(async () => {
      await recordStagedInboundMedia("staged-two.png");
      const stagedAt = (await resolveInboundMediaOwnership("staged-two.png"))?.stagedAt;
      expect(await recordInboundMediaOwner("staged-two.png", { sessionKey: "agent:main:a" })).toBe(
        true,
      );
      const ownership = await resolveInboundMediaOwnership("staged-two.png");
      expect(ownership).toMatchObject({ sessionKey: "agent:main:a", stagedAt });
    });
  });

  it("leaves objects that were never staged unowned", async () => {
    await withStateDir(async () => {
      expect(await resolveInboundMediaOwnership("channel-attachment.png")).toBeUndefined();
    });
  });

  it("refuses ids that are not a single bounded path component", async () => {
    await withStateDir(async () => {
      for (const id of [
        "",
        ".",
        "..",
        "../escape.png",
        "nested/escape.png",
        "nested\\escape.png",
      ]) {
        expect(isSafeInboundMediaId(id), id).toBe(false);
        expect(await recordStagedInboundMedia(id), id).toBe(false);
        expect(await resolveInboundMediaOwnership(id), id).toBeUndefined();
      }
      expect(isSafeInboundMediaId("safe.png")).toBe(true);
    });
  });

  it("parses only canonical managed references", () => {
    expect(inboundMediaIdFromReference("media://inbound/one.png")).toBe("one.png");
    expect(inboundMediaIdFromReference("media://inbound/a%20b.png")).toBe("a b.png");
    for (const source of [
      "media://other/one.png",
      "media://inbound/nested/one.png",
      "media://inbound/",
      "/tmp/one.png",
      "https://files.example/one.png",
      "media://inbound/one.png?ticket=1",
    ]) {
      expect(inboundMediaIdFromReference(source), source).toBeUndefined();
    }
  });

  it("binds every staged reference a persisted value carries", async () => {
    await withStateDir(async () => {
      await recordStagedInboundMedia("persisted.png");
      const message = {
        role: "toolResult",
        content: [
          { type: "text", text: "loaded" },
          { type: "image", mimeType: "image/png", url: "media://inbound/persisted.png" },
        ],
        details: { media: { mediaUrls: ["media://inbound/never-staged.png"] } },
      };
      expect(collectInboundMediaIds(message)).toEqual(["persisted.png", "never-staged.png"]);
      const bound = await recordInboundMediaOwnersInValue(message, { sessionKey: "agent:main:b" });
      expect(bound).toEqual(["persisted.png"]);
      expect((await resolveInboundMediaOwnership("persisted.png"))?.sessionKey).toBe(
        "agent:main:b",
      );
      // A reference this registry never staged belongs to another lane, such as a channel
      // attachment, and binding it would narrow that lane's access.
      expect(await resolveInboundMediaOwnership("never-staged.png")).toBeUndefined();
    });
  });
});
