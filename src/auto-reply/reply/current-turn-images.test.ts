import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
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

const stateDirEnv = captureEnv(["OPENCLAW_STATE_DIR"]);
const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");

const image = (data: string, mimeType = "image/png") => ({
  type: "image" as const,
  data: Buffer.from(data).toString("base64"),
  mimeType,
});
const media = (base: string, name: string, contentType = "image/png") => ({
  path: path.join(base, name),
  workspaceDir: base,
  contentType,
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
async function writeMedia(
  name: string,
  bytes = name,
  base = tempDirs.make("current-turn-images-"),
) {
  const attachment = media(base, name);
  await fs.mkdir(path.dirname(attachment.path), { recursive: true });
  await fs.writeFile(attachment.path, bytes);
  return attachment;
}
function resolve(
  input: MsgContext & Omit<Parameters<typeof resolveCurrentTurnImages>[0], "ctx" | "cfg">,
) {
  const { images, imageOrder, extractedFileImages, ...ctx } = input;
  return resolveCurrentTurnImages({ ctx, cfg: {}, images, imageOrder, extractedFileImages });
}

describe("resolveCurrentTurnImages", () => {
  afterEach(() => {
    stateDirEnv.restore();
    vi.restoreAllMocks();
  });

  it("hydrates Telegram-style state-relative media into native prompt images", async () => {
    const base = tempDirs.make("openclaw-current-turn-images-");
    const stateDir = path.join(base, "state");
    const cwd = path.join(base, "cwd");
    const relativePath = "media/inbound/telegram.jpg";
    await writeMedia(relativePath, "telegram-image", stateDir);
    await fs.mkdir(cwd, { recursive: true });
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    const result = await resolve({ media: [{ path: relativePath, contentType: "image/jpeg" }] });

    expect(result).toStrictEqual({
      images: [image("telegram-image", "image/jpeg")],
      imageOrder: ["inline"],
    });
  });

  it("rejects PDF bytes despite a spoofed image kind, MIME, and filename", async () => {
    const attachment = await writeMedia("spoofed.png", PDF_BYTES.toString());
    const result = await resolve({ media: [{ ...attachment, kind: "image" }] });
    expect(result.images).toBeUndefined();
  });

  it("does not duplicate a prepared host-staged image during runner hydration", async () => {
    const base = tempDirs.make("openclaw-current-turn-images-");
    const stagingRoot = path.join(base, "media", "inbound", "staged");
    const attachment = await writeMedia("photo.png", "host-staged-image", stagingRoot);
    const prepared = await resolve({ media: [attachment] });
    const runner = await resolve({
      media: [{ path: attachment.path, contentType: attachment.contentType }],
      images: prepared.images,
      imageOrder: prepared.imageOrder,
    });

    expect(prepared.images).toEqual([image("host-staged-image")]);
    expect(runner.images).toEqual(prepared.images);
  });

  it("does not let a staging root expose sibling workspace images", async () => {
    const base = tempDirs.make("openclaw-current-turn-images-");
    const stagingRoot = path.join(base, "media", "inbound", "staged");
    const attachment = await writeMedia("private.png", "private-workspace-image", base);
    await fs.mkdir(stagingRoot, { recursive: true });
    const result = await resolve({
      media: [{ ...attachment, workspaceDir: stagingRoot }],
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
    const suppressed = { ...media("/state/media/inbound", "photo.png"), hydrationSuppressed: true };
    const result = await resolve({
      media: [suppressed],
      images: [inlineImage],
      imageOrder: ["inline"],
    });

    expect(result).toEqual({ images: [inlineImage], imageOrder: ["inline"] });
    expect(resolveAgentTurnAttachments).not.toHaveBeenCalled();
  });

  it("orders extracted PDF page images before later current image attachments", async () => {
    const attachment = await writeMedia("photo.png", "current-photo");
    const result = await resolve({
      media: [media(attachment.workspaceDir, "scan.pdf", "application/pdf"), attachment],
      extractedFileImages: [{ ...image("pdf-page"), attachmentIndex: 0 }],
    });

    expect(result).toMatchObject({
      images: [image("pdf-page"), image("current-photo")],
      imageOrder: ["inline", "inline"],
    });
  });

  it("retains undescribed native images when a described sibling and missing sibling coexist", async () => {
    const { workspaceDir: base } = await writeMedia("present.png", "present-image");
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

    expect(result).toMatchObject({
      images: [image("present-image")],
      imageOrder: ["inline"],
      imageSourceIndexes: [1],
      unresolvedSourceIndexes: [2],
    });
  });

  it("proceeds without native images when current media resolution throws", async () => {
    vi.mocked(resolveAgentTurnAttachments).mockRejectedValueOnce(new Error("boom"));
    const result = await resolve({ media: [media("/unused", "present.png")] });
    expect(result.images).toBeUndefined();
    expect(result.imageOrder).toBeUndefined();
    expect(result.imageSourceIndexes).toBeUndefined();
    expect(result.unresolvedSourceIndexes).toEqual([0]);
  });
});
