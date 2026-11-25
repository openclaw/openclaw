import { buffer } from "node:stream/consumers";
import type { Download } from "playwright";

export async function readControlUiE2eDownload(download: Download): Promise<Buffer> {
  // Download paths belong to the browser host; streams also work over remote connections.
  return buffer(await download.createReadStream());
}
