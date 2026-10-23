import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import type { MsgContext } from "../templating.js";
import { resolveAgentTurnAttachments } from "./agent-turn-attachments.js";
import { resolveCurrentTurnImages } from "./current-turn-images.js";

vi.mock("./agent-turn-attachments.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-turn-attachments.js")>();
  return {
    ...actual,
    resolveAgentTurnAttachments: vi.fn(actual.resolveAgentTurnAttachments),
  };
});

const originalStateDirEnv = process.env.OPENCLAW_STATE_DIR;
const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");

const image = (data: string | Buffer, mimeType = "image/png") => ({
  type: "image" as const,
  data: (typeof data === "string" ? Buffer.from(data) : data).toString("base64"),
  mimeType,
});
const media = (base: string, name: string, contentType = "image/png") => ({
  path: path.join(base, name),
  workspaceDir: base,
  contentType,
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function resolve({
  images,
  imageOrder,
  extractedFileImages,
  ...ctx
}: MsgContext & Omit<Parameters<typeof resolveCurrentTurnImages>[0], "ctx" | "cfg">) {
  return resolveCurrentTurnImages({
    ctx: { Body: "caption", ...ctx },
    cfg: {},
    images,
    imageOrder,
    extractedFileImages,
  });
}

describe("resolveCurrentTurnImages", () => {
  afterEach(() => {
    if (originalStateDirEnv === undefined) {
      deleteTestEnvValue("OPENCLAW_STATE_DIR");
    } else {
      setTestEnvValue("OPENCLAW_STATE_DIR", originalStateDirEnv);
    }
    vi.restoreAllMocks();
  });

  it("hydrates Telegram-style state-relative media into native prompt images", async () => {
    const base = tempDirs.make("openclaw-current-turn-images-");
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

    const result = await resolve({ media: [{ path: relativePath, contentType: "image/jpeg" }] });

    expect(result).toStrictEqual({
      images: [image(imageBytes, "image/jpeg")],
      imageOrder: ["inline"],
    });
  });

  it("rejects PDF bytes despite a spoofed image kind, MIME, and filename", async () => {
    const base = tempDirs.make("openclaw-current-turn-images-");
    await fs.writeFile(path.join(base, "spoofed.png"), PDF_BYTES);

    const result = await resolve({ media: [{ ...media(base, "spoofed.png"), kind: "image" }] });

    expect(result.images).toBeUndefined();
  });

  it("does not duplicate a prepared host-staged image during runner hydration", async () => {
    const base = tempDirs.make("openclaw-current-turn-images-");
    const stagingRoot = path.join(base, "media", "inbound", "staged");
    const imagePath = path.join(stagingRoot, "photo.png");
    const imageBytes = Buffer.from("host-staged-image");
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, imageBytes);
    const attachment = { path: imagePath, contentType: "image/png" };

    const prepared = await resolve({
      media: [{ ...attachment, workspaceDir: stagingRoot }],
    });
    const runner = await resolve({
      media: [attachment],
      images: prepared.images,
      imageOrder: prepared.imageOrder,
    });

    expect(prepared.images).toHaveLength(1);
    expect(Buffer.from(prepared.images?.[0]?.data ?? "", "base64")).toEqual(imageBytes);
    expect(runner.images).toEqual(prepared.images);
  });

  it("does not let a staging root expose sibling workspace images", async () => {
    const base = tempDirs.make("openclaw-current-turn-images-");
    const stagingRoot = path.join(base, "media", "inbound", "staged");
    const rejectedPath = path.join(base, "private.png");
    await fs.mkdir(stagingRoot, { recursive: true });
    await fs.writeFile(rejectedPath, "private-workspace-image");

    const result = await resolve({
      media: [{ path: rejectedPath, contentType: "image/png", workspaceDir: stagingRoot }],
    });

    expect(result.images).toBeUndefined();
  });

  it.each([
    { images: [], imageOrder: ["offloaded", "offloaded"] },
    { images: [image("first"), image("second")], imageOrder: ["inline", "offloaded", "inline"] },
  ] satisfies Parameters<typeof resolve>[0][])(
    "preserves provided image slots: $imageOrder",
    async (input) => {
      expect(await resolve(input)).toEqual({
        ...(input.images.length ? { images: input.images } : {}),
        imageOrder: input.imageOrder,
      });
    },
  );

  it("does not rehydrate a managed copy of an already-provided inline image", async () => {
    vi.mocked(resolveAgentTurnAttachments).mockClear();
    const inlineImage = image("inline");

    const result = await resolve({
      media: [
        {
          path: "/state/media/inbound/photo.png",
          contentType: "image/png",
          hydrationSuppressed: true,
        },
      ],
      images: [inlineImage],
      imageOrder: ["inline"],
    });

    expect(result).toEqual({ images: [inlineImage], imageOrder: ["inline"] });
    expect(resolveAgentTurnAttachments).not.toHaveBeenCalled();
  });

  it("orders extracted PDF page images before later current image attachments", async () => {
    const base = tempDirs.make("openclaw-current-turn-images-");
    await fs.writeFile(path.join(base, "photo.png"), "current-photo");
    const result = await resolve({
      media: [media(base, "scan.pdf", "application/pdf"), media(base, "photo.png")],
      extractedFileImages: [{ ...image("pdf-page"), attachmentIndex: 0 }],
    });

    expect(result.images?.map((entry) => Buffer.from(entry.data, "base64").toString())).toEqual([
      "pdf-page",
      "current-photo",
    ]);
    expect(result.imageOrder).toEqual(["inline", "inline"]);
  });

  it("retains undescribed native images when a described sibling and missing sibling coexist", async () => {
    const base = tempDirs.make("openclaw-current-turn-images-");
    const imageBytes = Buffer.from("present-image");
    await fs.writeFile(path.join(base, "present.png"), imageBytes);

    const result = await resolve({
      media: ["described.png", "present.png", "missing.png"].map((name) => media(base, name)),
      MediaUnderstanding: [
        {
          kind: "image.description",
          attachmentIndex: 0,
          provider: "imageModel",
          text: "an already described image",
        },
      ],
    });

    expect(result.images).toEqual([image(imageBytes)]);
    expect(result.imageOrder).toEqual(["inline"]);
    expect(result.imageSourceIndexes).toEqual([1]);
    expect(result.unresolvedSourceIndexes).toEqual([2]);
  });

  it("proceeds without native images when current media resolution throws", async () => {
    vi.mocked(resolveAgentTurnAttachments).mockRejectedValueOnce(new Error("boom"));
    const base = tempDirs.make("openclaw-current-turn-images-");
    await fs.writeFile(path.join(base, "present.png"), "present-image");

    const result = await resolve({ media: [media(base, "present.png")] });

    expect(result.images).toBeUndefined();
    expect(result.imageOrder).toBeUndefined();
    expect(result.imageSourceIndexes).toBeUndefined();
    expect(result.unresolvedSourceIndexes).toEqual([0]);
  });
});
