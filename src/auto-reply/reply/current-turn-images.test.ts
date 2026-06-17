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

  it("preserves partial results when some attachments fail to resolve", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-images-" }, async (base) => {
      const stateDir = path.join(base, "state");
      const validPath = "media/inbound/valid.jpg";
      const validAttachmentPath = path.join(stateDir, validPath);
      const imageBytes = Buffer.from("valid-image-bytes");
      await fs.mkdir(path.dirname(validAttachmentPath), { recursive: true });
      await fs.writeFile(validAttachmentPath, imageBytes);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      vi.spyOn(process, "cwd").mockReturnValue(path.join(base, "cwd"));
      await fs.mkdir(path.join(base, "cwd"), { recursive: true });

      const result = await resolveCurrentTurnImages({
        ctx: {
          MediaPaths: [validPath, "media/inbound/missing.jpg"],
          MediaTypes: ["image/jpeg", "image/jpeg"],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
      });

      // missing.jpg doesn't exist → resolveAgentTurnAttachments loads 1/2.
      // We should preserve the one valid image instead of dropping everything.
      expect(result.images).toHaveLength(1);
      expect(result.images?.[0]).toMatchObject({
        type: "image",
        data: imageBytes.toString("base64"),
        mimeType: "image/jpeg",
      });
    });
  });

  it("falls back when no attachments resolve", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-images-" }, async (base) => {
      const stateDir = path.join(base, "state");
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      vi.spyOn(process, "cwd").mockReturnValue(path.join(base, "cwd"));
      await fs.mkdir(path.join(base, "cwd"), { recursive: true });

      const result = await resolveCurrentTurnImages({
        ctx: {
          MediaPaths: ["media/inbound/missing1.jpg", "media/inbound/missing2.jpg"],
          MediaTypes: ["image/jpeg", "image/jpeg"],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
      });

      // Neither file exists → no images loaded.
      expect(result.images).toBeUndefined();
      expect(result.imageOrder).toBeUndefined();
    });
  });

  it("preserves partial results with correct ordering when middle attachment fails", async () => {
    await withTempDir({ prefix: "openclaw-current-turn-images-" }, async (base) => {
      const stateDir = path.join(base, "state");
      const firstPath = "media/inbound/first.jpg";
      const thirdPath = "media/inbound/third.jpg";
      const firstBytes = Buffer.from("first-image");
      const thirdBytes = Buffer.from("third-image");
      await fs.mkdir(path.join(stateDir, "media/inbound"), { recursive: true });
      await fs.writeFile(path.join(stateDir, firstPath), firstBytes);
      await fs.writeFile(path.join(stateDir, thirdPath), thirdBytes);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      vi.spyOn(process, "cwd").mockReturnValue(path.join(base, "cwd"));
      await fs.mkdir(path.join(base, "cwd"), { recursive: true });

      const result = await resolveCurrentTurnImages({
        ctx: {
          // Second attachment is missing; first and third should still resolve.
          MediaPaths: [firstPath, "media/inbound/missing.jpg", thirdPath],
          MediaTypes: ["image/jpeg", "image/jpeg", "image/jpeg"],
        } satisfies MsgContext,
        cfg: {} as OpenClawConfig,
      });

      // missing.jpg (index 1) doesn't exist → 2/3 loaded.
      // Both valid images should be preserved and ordered by sourceIndex (0, 2).
      expect(result.images).toHaveLength(2);
      expect(result.images?.[0]?.data).toBe(firstBytes.toString("base64"));
      expect(result.images?.[1]?.data).toBe(thirdBytes.toString("base64"));
      expect(result.imageOrder).toEqual(["inline", "inline"]);
    });
  });
});
