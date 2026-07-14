/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { encodeTerminalUpload, quoteTerminalUploadPath } from "./terminal-file-upload.ts";

const MAX_TERMINAL_UPLOAD_BYTES = 16 * 1024 * 1024;

describe("terminal file upload", () => {
  it("base64-encodes arbitrary browser files", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 255])], "scan.pdf");
    await expect(encodeTerminalUpload(file)).resolves.toBe("AAEC/w==");
  });

  it("rejects oversized files before reading them", async () => {
    const file = {
      name: "archive.zip",
      size: MAX_TERMINAL_UPLOAD_BYTES + 1,
      arrayBuffer: () => Promise.reject(new Error("should not read")),
    } as File;
    await expect(encodeTerminalUpload(file)).rejects.toThrow("16 MiB");
  });

  it("quotes paths for POSIX, PowerShell, and cmd terminals", () => {
    expect(quoteTerminalUploadPath("/tmp/report.pdf", "/bin/zsh")).toBe("/tmp/report.pdf");
    expect(quoteTerminalUploadPath("/tmp/report final.pdf", "/bin/zsh")).toBe(
      "'/tmp/report final.pdf'",
    );
    expect(quoteTerminalUploadPath("/tmp/it's.pdf", "/bin/zsh")).toBe("'/tmp/it'\\''s.pdf'");
    expect(quoteTerminalUploadPath("C:\\Temp\\report final.pdf", "pwsh.exe")).toBe(
      "'C:\\Temp\\report final.pdf'",
    );
    expect(quoteTerminalUploadPath("C:\\Temp\\report.pdf", "cmd.exe")).toBe(
      '"C:\\Temp\\report.pdf"',
    );
    expect(quoteTerminalUploadPath("C:\\Temp\\x$(touch pwned).txt", "C:\\Git\\bin\\bash.exe")).toBe(
      "'C:\\Temp\\x$(touch pwned).txt'",
    );
  });
});
