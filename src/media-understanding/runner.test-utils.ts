import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withEnvAsync } from "../test-utils/env.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.js";

type MediaFixtureParams = {
  ctx: { MediaPath: string; MediaType: string };
  media: ReturnType<typeof normalizeMediaAttachments>;
  cache: ReturnType<typeof createMediaAttachmentCache>;
};

export async function withMediaFixture(
  params: {
    filePrefix: string;
    extension: string;
    mediaType: string;
    fileContents: Buffer;
  },
  run: (params: MediaFixtureParams) => Promise<void>,
) {
  const tmpPath = path.join(
    os.tmpdir(),
    `${params.filePrefix}-${Date.now().toString()}.${params.extension}`,
  );
  await fs.writeFile(tmpPath, params.fileContents);
  const ctx = { MediaPath: tmpPath, MediaType: params.mediaType };
  const media = normalizeMediaAttachments(ctx);
  const cache = createMediaAttachmentCache(media, {
    localPathRoots: [path.dirname(tmpPath)],
  });

  try {
    await withEnvAsync({ PATH: "" }, async () => {
      await run({ ctx, media, cache });
    });
  } finally {
    await cache.cleanup();
    await fs.unlink(tmpPath).catch(() => {});
  }
}

export async function withAudioFixture(
  filePrefix: string,
  run: (params: MediaFixtureParams) => Promise<void>,
) {
  await withMediaFixture(
    {
      filePrefix,
      extension: "wav",
      mediaType: "audio/wav",
      fileContents: Buffer.from("RIFF"),
    },
    run,
  );
}
