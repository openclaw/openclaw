// @vitest-environment node
import { Ghostty } from "ghostty-web";
import { expect, it } from "vitest";

it("repaints all indexed colors and scrollback without recoloring explicit RGB or moving the cursor", async () => {
  const runtime = await Ghostty.load();
  const terminal = runtime.createTerminal(32, 20);
  const palette = [
    "#000000",
    "#f38ba8",
    "#a6e3a1",
    "#f9e2af",
    "#89b4fa",
    "#cba6f7",
    "#94e2d5",
    "#cdd6f4",
    "#585b70",
    "#ff899d",
    "#9fe044",
    "#faba4a",
    "#8db0ff",
    "#c7a9ff",
    "#a4daff",
    "#ffffff",
  ];
  const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const background = (row: number) => {
    const cell = terminal.getLine(row)![0]!;
    return [cell.bg_r, cell.bg_g, cell.bg_b];
  };
  try {
    for (let i = 0; i < 16; i++) {
      terminal.write(`\x1b[${i < 8 ? 40 + i : 100 + i - 8}m indexed \x1b[0m\r\n`);
    }
    terminal.write("\x1b[48;2;243;139;168m explicit RGB \x1b[0m");
    const cursor = terminal.getCursor();
    terminal.setThemeColors({
      foreground: 0xcdd6f4,
      background: 0x1e1e2e,
      cursor: 0x89b4fa,
      palette: palette.map((color) => Number.parseInt(color.slice(1), 16)),
    });
    for (let i = 0; i < 16; i++) {
      expect(background(i)).toEqual(rgb(palette[i]!));
    }
    expect(background(16)).toEqual([243, 139, 168]);
    expect(terminal.getCursor()).toEqual(cursor);
    terminal.write("\r\n\r\n\r\n\r\n\r\n\x1b]4;1;#123456\x07");
    terminal.update();
    const scrolled = terminal.getScrollbackLine(1)![0]!;
    expect([scrolled.bg_r, scrolled.bg_g, scrolled.bg_b]).toEqual([18, 52, 86]);
  } finally {
    terminal.free();
  }
});

it("keeps fragmented output intact and resets application colors to the active host defaults", async () => {
  const runtime = await Ghostty.load();
  const terminal = runtime.createTerminal(32, 8);
  const colors = {
    foreground: 0xcdd6f4,
    background: 0x1e1e2e,
    cursor: 0x89b4fa,
    palette: Array.from({ length: 16 }, (_, index) => 0x202020 + index * 0x030303),
  };
  try {
    terminal.write("\x1b[48;2;243;");
    terminal.setThemeColors(colors);
    terminal.write("139;168mfragment\x1b[0m");
    const line = terminal.getLine(0)!;
    expect(
      line
        .slice(0, 8)
        .map((cell) => String.fromCodePoint(cell.codepoint))
        .join(""),
    ).toBe("fragment");
    expect([line[0]!.bg_r, line[0]!.bg_g, line[0]!.bg_b]).toEqual([243, 139, 168]);
    terminal.write("\x1b]4;1;#12");
    terminal.setThemeColors({
      ...colors,
      foreground: 0xeeeeee,
      palette: colors.palette.map((value, i) => (i === 1 ? 0xf38ba8 : value)),
    });
    terminal.write("3456\x07\r\n\x1b[41m app \x1b[0m");
    let cell = terminal.getLine(1)![0]!;
    expect([cell.bg_r, cell.bg_g, cell.bg_b]).toEqual([18, 52, 86]);
    terminal.write("\x1b]104;1\x07\x1b]110\x07\x1b]111\x07");
    cell = terminal.getLine(1)![0]!;
    expect([cell.bg_r, cell.bg_g, cell.bg_b]).toEqual([243, 139, 168]);
    expect(terminal.getColors().foreground).toEqual({ r: 238, g: 238, b: 238 });
    expect(terminal.getColors().background).toEqual({ r: 30, g: 30, b: 46 });
  } finally {
    terminal.free();
  }
});
