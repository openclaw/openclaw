import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MsgContext } from "../auto-reply/templating.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.js";

type AudioFixtureParams = {
  ctx: MsgContext;
  media: ReturnType<typeof normalizeMediaAttachments>;
  cache: ReturnType<typeof createMediaAttachmentCache>;
};

export async function withAudioFixture(
  filePrefix: string,
  run: (params: AudioFixtureParams) => Promise<void>,
) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audio-fixture-"));
  const tmpPath = path.join(tmpDir, `${filePrefix}-${Date.now()}.wav`);
  await fs.writeFile(tmpPath, Buffer.from("RIFF"));
  const ctx: MsgContext = { MediaPath: tmpPath, MediaType: "audio/wav" };
  const media = normalizeMediaAttachments(ctx);
  const cache = createMediaAttachmentCache(media, {
    localPathRoots: [tmpDir],
  });

  try {
    await withEnvAsync({ PATH: "" }, async () => {
      await run({ ctx, media, cache });
    });
  } finally {
    await cache.cleanup();
    await fs.unlink(tmpPath).catch(() => {});
    await fs.rmdir(tmpDir).catch(() => {});
  }
}
