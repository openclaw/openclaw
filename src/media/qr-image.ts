import { loadQrCodeTuiRuntime } from "./qr-runtime.ts";

export async function renderQrPngBase64(
  input: string,
  opts: { scale?: number; marginModules?: number } = {},
): Promise<string> {
  const { scale = 6, marginModules = 4 } = opts;
  const { renderPngBase64 } = await loadQrCodeTuiRuntime();
  return await renderPngBase64(input, {
    margin: marginModules,
    scale,
  });
}
