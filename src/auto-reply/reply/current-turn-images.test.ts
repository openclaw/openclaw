// Tests current-turn native image hydration from inbound media paths.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import type { MsgContext } from "../templating.js";
import { resolveCurrentTurnImages } from "./current-turn-images.js";

const originalStateDirEnv = process.env.OPENCLAW_STATE_DIR;

function restoreProcessState() {
  if (originalStateDirEnv === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDirEnv;
  }
}

describe("resolveCurrentTurnImages", () => {
  afterEach(() => {
    restoreProcessState();
    vi.restoreAllMocks();
  });

  it("hydrates Telegram-style state-relative media into native prompt images", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-images-" }, async (base) => {
      const stateDir = path.join(base, "state");
      const cwd = path.join(base, "cwd");
      const relativePath = "media/inbound/telegram.jpg";
      const attachmentPath = path.join(stateDir, relativePath);
      const imageBytes = Buffer.from("telegram-image");
      await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
      await fs.mkdir(cwd, { recursive: true });
      await fs.writeFile(attachmentPath, imageBytes);
      process.env.OPENCLAW_STATE_DIR = stateDir;
      vi.spyOn(process, "cwd").mockReturnValue(cwd);

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "caption",
          MediaPath: relativePath,
          MediaPaths: [relativePath],
          MediaType: "image/jpeg",
          MediaTypes: ["image/jpeg"],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
      });

      expect(result).toStrictEqual({
        images: [
          {
            type: "image",
            data: imageBytes.toString("base64"),
            mimeType: "image/jpeg",
          },
        ],
        imageOrder: ["inline"],
      });
    });
  });

  it("merges current-turn extracted images with existing inline images", async () => {
    const existingImage = {
      type: "image" as const,
      data: Buffer.from("existing-image").toString("base64"),
      mimeType: "image/jpeg",
    };
    const extractedPdfPage = {
      type: "image" as const,
      data: Buffer.from("pdf-page").toString("base64"),
      mimeType: "image/png",
    };

    const result = await resolveCurrentTurnImages({
      ctx: {
        Body: "<media:document>",
        CurrentTurnImages: [extractedPdfPage],
        CurrentTurnImageOrder: ["inline"],
      } satisfies MsgContext,
      cfg: {} as OpenClawConfig,
      images: [existingImage],
      imageOrder: ["inline"],
    });

    expect(result).toStrictEqual({
      images: [existingImage, extractedPdfPage],
      imageOrder: ["inline", "inline"],
    });
  });

  it("does not merge extracted images twice across the prepare and run passes", async () => {
    const extractedPdfPage = {
      type: "image" as const,
      data: Buffer.from("pdf-page").toString("base64"),
      mimeType: "image/png",
    };
    const ctx = {
      Body: "<media:document>",
      CurrentTurnImages: [extractedPdfPage],
      CurrentTurnImageOrder: ["inline"],
    } satisfies MsgContext;

    const prepared = await resolveCurrentTurnImages({
      ctx,
      cfg: {} as OpenClawConfig,
    });
    const runPass = await resolveCurrentTurnImages({
      ctx,
      cfg: {} as OpenClawConfig,
      images: prepared.images,
      imageOrder: prepared.imageOrder,
    });

    expect(prepared).toStrictEqual({
      images: [extractedPdfPage],
      imageOrder: ["inline"],
    });
    expect(runPass).toStrictEqual(prepared);
    expect(ctx.CurrentTurnImages).toBeUndefined();
    expect(ctx.CurrentTurnImageOrder).toBeUndefined();
  });
});
