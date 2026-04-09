import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const saveMediaSourceMock = vi.hoisted(() => vi.fn());

vi.mock("../../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../media/store.js")>();
  return {
    ...actual,
    saveMediaSource: saveMediaSourceMock,
  };
});

import { stageLocalMediaPathsForGatewayRpc } from "./message-gateway-media.js";

describe("stageLocalMediaPathsForGatewayRpc", () => {
  afterEach(() => {
    saveMediaSourceMock.mockReset();
  });

  it("copies arbitrary absolute paths into managed media via saveMediaSource", async () => {
    const outside = path.join(os.tmpdir(), `openclaw-63461-${Date.now()}.bin`);
    await fs.writeFile(outside, Buffer.from("x"), { mode: 0o600 });

    saveMediaSourceMock.mockResolvedValue({
      path: "/state/media/outbound/staged.bin",
      id: "staged.bin",
      contentType: "application/octet-stream",
      size: 1,
    });

    await expect(
      stageLocalMediaPathsForGatewayRpc({
        cfg: {},
        mediaUrl: outside,
      }),
    ).resolves.toEqual({
      mediaUrl: "/state/media/outbound/staged.bin",
      mediaUrls: undefined,
    });

    expect(saveMediaSourceMock).toHaveBeenCalledWith(outside, undefined, "outbound");
    await fs.unlink(outside).catch(() => {});
  });

  it("does not call saveMediaSource when the path is already under allowed roots", async () => {
    const rootsModule = await import("../../media/local-roots.js");
    const roots = rootsModule.getAgentScopedMediaLocalRoots({}, undefined);
    const root = roots[0];
    if (!root) {
      throw new Error("expected default media local roots");
    }
    const inside = path.join(root, `nested-${Date.now()}.txt`);
    await fs.mkdir(path.dirname(inside), { recursive: true }).catch(() => {});
    await fs.writeFile(inside, Buffer.from("ok"), { mode: 0o600 });

    await expect(
      stageLocalMediaPathsForGatewayRpc({
        cfg: {},
        mediaUrl: inside,
      }),
    ).resolves.toEqual({
      mediaUrl: inside,
      mediaUrls: undefined,
    });

    expect(saveMediaSourceMock).not.toHaveBeenCalled();
    await fs.unlink(inside).catch(() => {});
  });

  it("passes through https URLs without staging", async () => {
    await expect(
      stageLocalMediaPathsForGatewayRpc({
        cfg: {},
        mediaUrl: "https://example.com/a.png",
      }),
    ).resolves.toEqual({
      mediaUrl: "https://example.com/a.png",
      mediaUrls: undefined,
    });
    expect(saveMediaSourceMock).not.toHaveBeenCalled();
  });
});
