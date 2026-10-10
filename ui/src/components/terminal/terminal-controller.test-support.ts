import { vi } from "vitest";
import { terminalFontFamily } from "../../app/terminal-font.ts";

export function createTerminalController(dispose: () => void = vi.fn()) {
  const wasmTerm = {};
  const renderer = {
    setTheme: vi.fn(),
    remeasureFont: vi.fn(),
    render: vi.fn(),
  };
  return {
    readOnly: false,
    terminal: {
      options: { fontFamily: terminalFontFamily() },
      cols: 100,
      rows: 30,
      viewportY: 0,
      wasmTerm,
      renderer,
      write: vi.fn(),
      focus: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      reset: vi.fn(),
      paste: vi.fn(),
    },
    write: vi.fn(),
    fit: vi.fn(),
    resize: vi.fn(),
    setReadOnly: vi.fn(),
    attach: vi.fn(),
    dispose,
  };
}
