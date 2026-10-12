import { bytesToBase64 } from "../../lib/bytes-base64.ts";

const MAX_PROFILE_AVATAR_EDGE = 512;
const MAX_PROFILE_AVATAR_BYTES = 512 * 1024;
const MAX_PROFILE_AVATAR_SOURCE_BYTES = 10 * 1024 * 1024;

type ProcessedProfileAvatar = {
  mime: "image/png" | "image/webp";
  avatarBase64: string;
  byteLength: number;
};

export class ProfileAvatarError extends Error {
  constructor(readonly code: "invalid-image" | "source-too-large" | "too-large") {
    super(code);
    this.name = "ProfileAvatarError";
  }
}

function canvasBlob(
  canvas: HTMLCanvasElement,
  mime: ProcessedProfileAvatar["mime"],
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, mime, quality);
  });
}

export async function processProfileAvatar(file: File): Promise<ProcessedProfileAvatar> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new ProfileAvatarError("invalid-image");
  }
  if (file.size > MAX_PROFILE_AVATAR_SOURCE_BYTES) {
    throw new ProfileAvatarError("source-too-large");
  }
  const objectUrl = URL.createObjectURL(file);
  let image: HTMLImageElement;
  try {
    image = new Image();
    image.decoding = "async";
    image.src = objectUrl;
    await image.decode();
  } catch {
    throw new ProfileAvatarError("invalid-image");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  const { naturalWidth: width, naturalHeight: height } = image;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ProfileAvatarError("invalid-image");
  }
  const sourceEdge = Math.min(width, height);
  const scale = Math.min(1, MAX_PROFILE_AVATAR_EDGE / sourceEdge);
  const edge = Math.max(1, Math.round(sourceEdge * scale));
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new ProfileAvatarError("invalid-image");
  }
  context.drawImage(
    image,
    Math.max(0, Math.round((width - sourceEdge) / 2)),
    Math.max(0, Math.round((height - sourceEdge) / 2)),
    sourceEdge,
    sourceEdge,
    0,
    0,
    edge,
    edge,
  );

  const preferredMime = file.type === "image/webp" ? "image/webp" : "image/png";
  let mime: ProcessedProfileAvatar["mime"] = preferredMime;
  let blob = await canvasBlob(canvas, mime, mime === "image/webp" ? 0.9 : undefined);
  if (!blob || blob.type !== mime || blob.size > MAX_PROFILE_AVATAR_BYTES) {
    mime = "image/webp";
    blob = await canvasBlob(canvas, mime, 0.82);
  }
  if (!blob || blob.type !== mime) {
    throw new ProfileAvatarError("invalid-image");
  }
  if (blob.size > MAX_PROFILE_AVATAR_BYTES) {
    throw new ProfileAvatarError("too-large");
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { mime, avatarBase64: bytesToBase64(bytes), byteLength: bytes.byteLength };
}
