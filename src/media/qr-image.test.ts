import { beforeEach, describe, expect, it, vi } from "vitest";

const renderPngBase64 = vi.hoisted(() => vi.fn(async () => "mocked-base64"));

vi.mock("@vincentkoc/qrcode-tui", () => ({
  renderPngBase64,
}));

import { renderQrPngBase64 } from "./qr-image.ts";

describe("renderQrPngBase64", () => {
  beforeEach(() => {
    renderPngBase64.mockClear();
  });

  it("delegates PNG rendering to qrcode-tui", async () => {
    await expect(renderQrPngBase64("openclaw", { scale: 8, marginModules: 2 })).resolves.toBe(
      "mocked-base64",
    );
    expect(renderPngBase64).toHaveBeenCalledWith("openclaw", {
      margin: 2,
      scale: 8,
    });
  });

  it("uses the default PNG rendering options", async () => {
    await renderQrPngBase64("openclaw");
    expect(renderPngBase64).toHaveBeenCalledWith("openclaw", {
      margin: 4,
      scale: 6,
    });
  });
});
