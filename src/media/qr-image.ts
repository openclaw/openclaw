import path from "node:path";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { loadQrCodeRuntime } from "./qr-runtime.ts";

const QR_PNG_DATA_URL_PREFIX = "data:image/png;base64,";

type QrPngRenderOptions = {
  scale?: number;
  marginModules?: number;
};

/** Temp-file write options kept to filename segments so callers cannot choose parent paths. */
type QrPngTempFileOptions = QrPngRenderOptions & {
  tmpRoot: string;
  dirPrefix: string;
  fileName?: string;
};

type QrPngTempFile = {
  filePath: string;
  dirPath: string;
  mediaLocalRoots: string[];
};

function resolveQrPngIntegerOption(name: string, input: number, min: number, max: number): number {
  if (!Number.isFinite(input)) {
    throw new RangeError(`${name} must be a finite number.`);
  }
  const value = Math.floor(input);
  if (value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

function resolveQrTempPathSegment(name: string, value: string): string {
  if (!value || value === "." || value === ".." || path.basename(value) !== value) {
    throw new RangeError(`${name} must be a non-empty filename segment.`);
  }
  return value;
}

async function renderQrPngBuffer(
  input: string,
  { scale = 6, marginModules = 4 }: QrPngRenderOptions,
): Promise<Buffer> {
  const resolvedScale = resolveQrPngIntegerOption("scale", scale, 1, 12);
  const margin = resolveQrPngIntegerOption("marginModules", marginModules, 0, 16);
  const qrCode = await loadQrCodeRuntime();
  return await qrCode.toBuffer(input, {
    margin,
    scale: resolvedScale,
  });
}

/** Renders QR text as raw PNG base64 after validating bounded renderer options. */
export async function renderQrPngBase64(
  input: string,
  opts: QrPngRenderOptions = {},
): Promise<string> {
  return (await renderQrPngBuffer(input, opts)).toString("base64");
}

export async function renderQrPngDataUrl(
  input: string,
  opts: QrPngRenderOptions = {},
): Promise<string> {
  return `${QR_PNG_DATA_URL_PREFIX}${await renderQrPngBase64(input, opts)}`;
}

/** Writes QR PNG output into a scoped temp directory and returns that directory as a media root. */
export async function writeQrPngTempFile(
  input: string,
  opts: QrPngTempFileOptions,
): Promise<QrPngTempFile> {
  const dirPrefix = resolveQrTempPathSegment("dirPrefix", opts.dirPrefix);
  const fileName = resolveQrTempPathSegment("fileName", opts.fileName ?? "qr.png");
  const png = await renderQrPngBuffer(input, opts);
  const workspace = await tempWorkspace({ rootDir: opts.tmpRoot, prefix: dirPrefix });
  const dirPath = workspace.dir;
  try {
    const filePath = await workspace.write(fileName, png);
    return {
      filePath,
      dirPath,
      mediaLocalRoots: [dirPath],
    };
  } catch (err) {
    await workspace.cleanup();
    throw err;
  }
}
