// Tests current-turn native image hydration from inbound media paths.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import type { MsgContext } from "../templating.js";
import { resolveCurrentTurnImages } from "./current-turn-images.js";

const originalStateDirEnv = process.env.OPENCLAW_STATE_DIR;

function restoreProcessState() {
  if (originalStateDirEnv === undefined) {
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
  } else {
    setTestEnvValue("OPENCLAW_STATE_DIR", originalStateDirEnv);
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
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
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

  it("appends extracted PDF page images without dropping current image attachments", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-pdf-images-" }, async (base) => {
      const imagePath = path.join(base, "photo.png");
      const imageBytes = Buffer.from("current-photo");
      await fs.writeFile(imagePath, imageBytes);

      const pdfPage = {
        type: "image" as const,
        data: Buffer.from("pdf-page").toString("base64"),
        mimeType: "image/png",
        attachmentIndex: 1,
      };

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "caption",
          MediaPaths: [imagePath, path.join(base, "scan.pdf")],
          MediaTypes: ["image/png", "application/pdf"],
          MediaWorkspaceDir: base,
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
        extractedFileImages: [pdfPage],
      });

      expect(result.images).toEqual([
        {
          type: "image",
          data: imageBytes.toString("base64"),
          mimeType: "image/png",
        },
        {
          type: "image",
          data: pdfPage.data,
          mimeType: "image/png",
        },
      ]);
      expect(result.imageOrder).toEqual(["inline", "inline"]);
    });
  });

  it("orders extracted PDF page images before later current image attachments", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-pdf-order-" }, async (base) => {
      const imagePath = path.join(base, "photo.png");
      await fs.writeFile(imagePath, "current-photo");
      const pdfPage = {
        type: "image" as const,
        data: Buffer.from("pdf-page").toString("base64"),
        mimeType: "image/png",
        attachmentIndex: 0,
      };

      const result = await resolveCurrentTurnImages({
        ctx: {
          Body: "caption",
          MediaPaths: [path.join(base, "scan.pdf"), imagePath],
          MediaTypes: ["application/pdf", "image/png"],
          MediaWorkspaceDir: base,
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
        extractedFileImages: [pdfPage],
      });

      expect(result.images?.map((image) => Buffer.from(image.data, "base64").toString())).toEqual([
        "pdf-page",
        "current-photo",
      ]);
      expect(result.imageOrder).toEqual(["inline", "inline"]);
    });
  });
});
