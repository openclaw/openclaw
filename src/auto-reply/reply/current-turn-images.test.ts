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

  it("uses and consumes extracted current-turn images", async () => {
    const image = {
      type: "image" as const,
      data: Buffer.from("rendered-pdf-page").toString("base64"),
      mimeType: "image/png",
    };
    const ctx = {
      Body: "scan",
      CurrentTurnImages: [image],
    } satisfies MsgContext;

    const result = await resolveCurrentTurnImages({
      ctx,
      cfg: {} as OpenClawConfig,
    });

    expect(result).toStrictEqual({
      images: [image],
      imageOrder: ["inline"],
    });
    expect(ctx.CurrentTurnImages).toBeUndefined();
  });

  it("appends extracted current-turn images to explicit inline images", async () => {
    const explicitImage = {
      type: "image" as const,
      data: Buffer.from("explicit-image").toString("base64"),
      mimeType: "image/jpeg",
    };
    const extractedImage = {
      type: "image" as const,
      data: Buffer.from("rendered-pdf-page").toString("base64"),
      mimeType: "image/png",
    };
    const ctx = {
      Body: "scan",
      CurrentTurnImages: [extractedImage],
    } satisfies MsgContext;

    const result = await resolveCurrentTurnImages({
      ctx,
      cfg: {} as OpenClawConfig,
      images: [explicitImage],
      imageOrder: ["offloaded"],
    });

    expect(result).toStrictEqual({
      images: [explicitImage, extractedImage],
      imageOrder: ["offloaded", "inline"],
    });
    expect(ctx.CurrentTurnImages).toBeUndefined();
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
});
