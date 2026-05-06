import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildClawtributorAvatarAssetPath,
  needsLocalAvatarAsset,
  resolveRenderableAvatarUrl,
} from "../../scripts/update-clawtributors-avatar.js";

const tempDirs: string[] = [];

describe("scripts/update-clawtributors-avatar", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
      }),
    );
  });

  it("detects when a fetched avatar needs a local resized asset", () => {
    expect(needsLocalAvatarAsset({ width: 420, height: 420 }, 48)).toBe(true);
    expect(needsLocalAvatarAsset({ width: 48, height: 48 }, 48)).toBe(false);
  });

  it("builds stable local avatar asset paths from the contributor login", () => {
    expect(
      buildClawtributorAvatarAssetPath(
        {
          key: "18-rajat",
          login: "18-RAJAT",
          display: "Rajat Joshi",
          avatar_url: "https://avatars.githubusercontent.com/u/78920780?v=4&s=48",
        },
        "docs/assets/clawtributors",
      ),
    ).toBe("docs/assets/clawtributors/18-rajat.png");
  });

  it("keeps remote avatar urls when GitHub already returns the requested size", async () => {
    const buffer = await sharp({
      create: { width: 48, height: 48, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const tempDir = await createTempDir();
    const result = await resolveRenderableAvatarUrl(
      {
        key: "andyk-ms",
        login: "andyk-ms",
        display: "Andy",
        avatar_url: "https://avatars.githubusercontent.com/u/91510251?v=4&s=48",
      },
      {
        avatarSize: 48,
        assetDir: tempDir,
        assetPathPrefix: "docs/assets/clawtributors",
        fetchImpl: async () => new Response(buffer, { status: 200 }),
      },
    );

    expect(result).toEqual({
      avatarUrl: "https://avatars.githubusercontent.com/u/91510251?v=4&s=48",
      usedLocalAsset: false,
    });
  });

  it("writes and returns a local resized asset for oversized avatars", async () => {
    const buffer = await sharp({
      create: {
        width: 420,
        height: 420,
        channels: 4,
        background: { r: 20, g: 40, b: 60, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const tempDir = await createTempDir();

    const result = await resolveRenderableAvatarUrl(
      {
        key: "18-rajat",
        login: "18-RAJAT",
        display: "Rajat Joshi",
        avatar_url: "https://avatars.githubusercontent.com/u/78920780?v=4&s=48",
      },
      {
        avatarSize: 48,
        assetDir: tempDir,
        assetPathPrefix: "docs/assets/clawtributors",
        fetchImpl: async () => new Response(buffer, { status: 200 }),
      },
    );

    expect(result).toEqual({
      avatarUrl: "docs/assets/clawtributors/18-rajat.png",
      usedLocalAsset: true,
    });

    const resized = await readFile(path.join(tempDir, "18-rajat.png"));
    await expect(sharp(resized).metadata()).resolves.toMatchObject({ width: 48, height: 48 });
  });

  it("reuses an existing local asset when the remote avatar cannot be fetched", async () => {
    const tempDir = await createTempDir();
    const existing = await sharp({
      create: {
        width: 48,
        height: 48,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    await writeFile(path.join(tempDir, "18-rajat.png"), existing);

    const result = await resolveRenderableAvatarUrl(
      {
        key: "18-rajat",
        login: "18-RAJAT",
        display: "Rajat Joshi",
        avatar_url: "https://avatars.githubusercontent.com/u/78920780?v=4&s=48",
      },
      {
        avatarSize: 48,
        assetDir: tempDir,
        assetPathPrefix: "docs/assets/clawtributors",
        fetchImpl: async () => {
          throw new Error("network down");
        },
      },
    );

    expect(result).toEqual({
      avatarUrl: "docs/assets/clawtributors/18-rajat.png",
      usedLocalAsset: true,
    });
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-clawtributors-avatar-"));
  tempDirs.push(dir);
  return dir;
}
