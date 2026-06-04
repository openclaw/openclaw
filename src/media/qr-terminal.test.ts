import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, toString } = vi.hoisted(() => ({
  create: vi.fn(() => ({
    modules: {
      data: [1, 0, 0, 1],
      size: 2,
    },
  })),
  toString: vi.fn(async () => "ASCII-QR"),
}));

vi.mock("qrcode", () => ({
  default: {
    create,
    toString,
  },
}));

import { renderQrTerminal } from "./qr-terminal.ts";

describe("renderQrTerminal", () => {
  beforeEach(() => {
    create.mockClear();
    toString.mockClear();
  });

  it("renders full QR output without qrcode terminal mode", async () => {
    const rendered = await renderQrTerminal("openclaw");
    expect(rendered).toContain("██");
    expect(rendered).toContain("\x1b[48;2;255;255;255m\x1b[38;2;0;0;0m");
    expect(create).toHaveBeenCalledWith("openclaw");
    expect(toString).not.toHaveBeenCalled();
  });

  it("renders compact QR output without qrcode terminal small mode", async () => {
    const rendered = await renderQrTerminal("openclaw", { small: true });
    expect(rendered).toContain("▄");
    expect(create).toHaveBeenCalledWith("openclaw");
    expect(toString).not.toHaveBeenCalled();
  });

  it("rejects empty QR text", async () => {
    await expect(renderQrTerminal("")).rejects.toThrow("QR text must not be empty.");
    expect(toString).not.toHaveBeenCalled();
  });
});
