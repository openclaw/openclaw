import { messagingApi } from "@line/bot-sdk";
import { logVerbose } from "../globals.js";
import { saveMediaBuffer } from "../media/store.js";

interface DownloadResult {
  path: string;
  contentType?: string;
  size: number;
}

export async function downloadLineMedia(
  messageId: string,
  channelAccessToken: string,
  maxBytes = 10 * 1024 * 1024,
  originalFilename?: string,
): Promise<DownloadResult> {
  const client = new messagingApi.MessagingApiBlobClient({
    channelAccessToken,
  });

  const httpResponse = await client.getMessageContentWithHttpInfo(messageId);

  const contentType = httpResponse.httpResponse.headers.get("content-type") ?? undefined;

  // httpResponse.body is a Readable stream
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of httpResponse.body as AsyncIterable<Buffer>) {
    totalSize += chunk.length;
    if (totalSize > maxBytes) {
      throw new Error(`Media exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    }
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  // Save to ~/.openclaw/media/inbound/ so sandbox can access the file.
  // Previously saved to /tmp/openclaw/ which was outside the sandbox root.
  const saved = await saveMediaBuffer(buffer, contentType, "inbound", maxBytes, originalFilename);

  logVerbose(`line: downloaded media ${messageId} to ${saved.path} (${saved.size} bytes)`);

  return {
    path: saved.path,
    contentType: saved.contentType,
    size: saved.size,
  };
}
