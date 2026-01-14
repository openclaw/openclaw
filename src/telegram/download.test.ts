import { describe, expect, it, vi } from "vitest";

import { downloadTelegramFile, getTelegramFile, type TelegramFileInfo } from "./download.js";

describe("telegram download", () => {
  it("fetches file info", async () => {
    const json = vi.fn().mockResolvedValue({ ok: true, result: { file_path: "photos/1.jpg" } });
    vi.spyOn(global, "fetch" as never).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json,
    } as Response);
    const info = await getTelegramFile("tok", "fid");
    expect(info.file_path).toBe("photos/1.jpg");
  });

  it("downloads and saves", async () => {
    const info: TelegramFileInfo = {
      file_id: "fid",
      file_path: "photos/1.jpg",
    };
    const arrayBuffer = async () => new Uint8Array([1, 2, 3, 4]).buffer;
    vi.spyOn(global, "fetch" as never).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      body: true,
      arrayBuffer,
      headers: { get: () => "image/jpeg" },
    } as Response);
    const saved = await downloadTelegramFile("tok", info, 1024 * 1024);
    expect(saved.path).toBeTruthy();
    expect(saved.contentType).toBe("image/jpeg");
  });
});
