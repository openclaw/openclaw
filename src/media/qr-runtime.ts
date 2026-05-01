import type QRCode from "qrcode";

type QrCodeRuntime = typeof QRCode;

let qrCodeRuntimePromise: Promise<QrCodeRuntime> | null = null;

// Some staged plugin-runtime-deps trees ship `qrcode` without an
// addressable `package.json` (or a usable `main` resolution under ESM),
// so bare `import("qrcode")` fails with `Cannot find package 'qrcode'`
// even though the package files are present on disk (#75394). Node's own
// error message hints at the working path: `qrcode/lib/index.js`. Try the
// bare specifier first to keep the dev/non-staged path canonical, then
// fall back to the explicit lib entry. Re-throw the original error if
// both attempts fail so the message stays diagnostic.
async function importQrCodeRuntimeWithFallback(): Promise<QrCodeRuntime> {
  try {
    const mod = await import("qrcode");
    return (mod.default ?? mod) as QrCodeRuntime;
  } catch (bareError) {
    try {
      const mod = (await import(
        // The explicit subpath is what Node suggests when the bare specifier
        // fails. Cast through `unknown` because TypeScript does not declare
        // the subpath in the `qrcode` types.
        /* @vite-ignore */ "qrcode/lib/index.js" as unknown as "qrcode"
      )) as { default?: QrCodeRuntime } & QrCodeRuntime;
      return (mod.default ?? mod) as QrCodeRuntime;
    } catch {
      throw bareError;
    }
  }
}

export async function loadQrCodeRuntime(): Promise<QrCodeRuntime> {
  if (!qrCodeRuntimePromise) {
    qrCodeRuntimePromise = importQrCodeRuntimeWithFallback();
  }
  return await qrCodeRuntimePromise;
}

/** Test-only: drop the cached runtime promise so a subsequent loader call retries. */
export function _resetQrCodeRuntimeCacheForTest(): void {
  qrCodeRuntimePromise = null;
}

export function normalizeQrText(text: string): string {
  if (typeof text !== "string") {
    throw new TypeError("QR text must be a string.");
  }
  if (text.length === 0) {
    throw new Error("QR text must not be empty.");
  }
  return text;
}
