/* @vitest-environment jsdom */

import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createTerminalController } from "./terminal-controller.test-support.ts";
import { createTerminalPanelUpload, type TerminalPanelUpload } from "./terminal-panel-upload.ts";

const MAX_TERMINAL_UPLOAD_BYTES = 16 * 1024 * 1024;

function dropUpload(path: string, shell: string, uploadPathStyle?: "native", oversized = false) {
  const base = createApplicationConfigCapability({ resourceBasePath: "" });
  const config = { ...base, current: { ...base.current, uploadsEnabled: true } };
  const terminal = createTerminalController();
  const tab = {
    gatewaySessionId: "session-1",
    shell,
    status: "live",
    // Only the terminal I/O adapter is substituted; upload admission is real.
    controller: terminal as unknown as GhosttyTerminalController,
  };
  const request = vi.fn().mockResolvedValue({ path, size: 4, uploadPathStyle });
  let upload!: TerminalPanelUpload;
  mountSolid(() => {
    upload = createTerminalPanelUpload({
      config: () => config,
      activeTab: () => tab,
      client: () => ({ request, forceReconnect: () => {}, addEventListener: () => () => {} }),
      isCurrent: (candidate) => candidate === tab,
      fileInput: () => null,
      setError: vi.fn(),
    });
    return null;
  });
  const file = new File(["file"], oversized ? "archive.zip" : "report.pdf");
  const arrayBuffer = vi.fn(async () => new TextEncoder().encode("file").buffer);
  Object.defineProperty(file, "arrayBuffer", { value: arrayBuffer });
  if (oversized) {
    Object.defineProperty(file, "size", { value: MAX_TERMINAL_UPLOAD_BYTES + 1 });
  }
  const drop = new Event("drop", { cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [file] } });
  upload.handleDrop(drop as DragEvent);
  return { upload, terminal, request, arrayBuffer };
}

describe("terminal file upload", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });

  it.each([
    ["/tmp/report.pdf", "/bin/zsh", "/tmp/report.pdf"],
    ["/tmp/report final.pdf", "/bin/zsh", "'/tmp/report final.pdf'"],
    ["/tmp/it's.pdf", "/bin/zsh", "'/tmp/it'\\''s.pdf'"],
    ["C:\\Temp\\report final.pdf", "pwsh.exe", "'C:\\Temp\\report final.pdf'"],
    ["C:\\Temp\\report.pdf", "cmd.exe", '"C:\\Temp\\report.pdf"'],
    ["C:\\Temp\\x$(touch pwned).txt", "C:\\Git\\bin\\bash.exe", "'C:\\Temp\\x$(touch pwned).txt'"],
  ])("inserts an editable quoted path for %s in %s", async (path, shell, expected) => {
    const { terminal, request } = dropUpload(path, shell);
    await waitForSolid(() => expect(terminal.terminal.paste).toHaveBeenCalledWith(expected));
    expect(terminal.terminal.paste).toHaveBeenCalledTimes(1);
    expect(terminal.terminal.input).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "terminal.upload",
      { sessionId: "session-1", name: "report.pdf", contentBase64: "ZmlsZQ==" },
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    ["/tmp/report.pdf", '"/tmp/report.pdf"'],
    ["/tmp/it's final.pdf", '"/tmp/it\'s final.pdf"'],
    ['/tmp/reviewer"s $notes`\\draft.pdf', '"/tmp/reviewer\\"s \\$notes\\`\\\\draft.pdf"'],
    [
      "C:\\Users\\O'Brien\\$cash%value!\\report final.pdf",
      '"C:\\Users\\O\'Brien\\$cash%value!\\report final.pdf"',
    ],
    ["\\\\server\\O'Brien\\report final.pdf", '"\\\\server\\O\'Brien\\report final.pdf"'],
    ["\\\\?\\C:\\Users\\O'Brien\\report.pdf", '"\\\\?\\C:\\Users\\O\'Brien\\report.pdf"'],
  ])("uses the native CLI path contract for %s", async (path, expected) => {
    const { terminal } = dropUpload(path, "claude --resume 12345678…", "native");
    await waitForSolid(() => expect(terminal.terminal.paste).toHaveBeenCalledWith(expected));
    expect(terminal.terminal.input).not.toHaveBeenCalled();
  });

  it.each([
    ["C:\\Temp\\x$(touch pwned).txt", "wsl.exe", undefined, "unsupported shell: wsl.exe"],
    [
      "\\\\server\\profiles\\x$(touch pwned).txt",
      "wsl.exe",
      undefined,
      "unsupported shell: wsl.exe",
    ],
    ["/tmp/report.pdf", "claude --resume 12345678…", undefined, "unsupported shell"],
    ["relative.pdf", "native CLI", "native", "Cannot safely insert the uploaded native file path"],
    [
      "/tmp/report\nnext.pdf",
      "native CLI",
      "native",
      "Cannot safely insert the uploaded native file path",
    ],
    [
      'C:\\Temp\\bad"path.pdf',
      "native CLI",
      "native",
      "Cannot safely insert the uploaded native file path",
    ],
    ["C:\\Users\\bang!\\report.pdf", "cmd.exe", undefined, "path containing % or ! into cmd.exe"],
  ] as const)("refuses unsafe insertion for %s in %s", async (path, shell, style, message) => {
    const { upload, terminal } = dropUpload(path, shell, style);
    await waitForSolid(() => {
      expect(upload.progress()).toMatchObject({ state: "failed", retryable: false });
      expect(upload.progress()?.error).toContain(message);
    });
    expect(terminal.terminal.paste).not.toHaveBeenCalled();
  });

  it("localizes validation and rejects files over 16 MiB before reading or sending", async () => {
    i18n.registerTranslation("pt-BR", {
      terminal: {
        uploadTooLarge: "O arquivo excede o limite de 16 MiB: {file}",
        uploadUnsafeCmdPath: "O caminho enviado não é seguro para cmd.exe",
        uploadUnsupportedShell: "Shell sem suporte para caminho enviado: {shell}",
      },
    });
    await i18n.setLocale("pt-BR");
    const oversized = dropUpload("/tmp/archive.zip", "/bin/zsh", undefined, true);
    await waitForSolid(() => {
      expect(oversized.upload.progress()).toMatchObject({
        state: "failed",
        retryable: false,
        error: "O arquivo excede o limite de 16 MiB: archive.zip",
      });
    });
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
    expect(oversized.request).not.toHaveBeenCalled();
    expect(oversized.terminal.terminal.paste).not.toHaveBeenCalled();
    const unsupported = dropUpload("/tmp/report.pdf", "nu");
    await waitForSolid(() => {
      expect(unsupported.upload.progress()?.error).toBe(
        "Shell sem suporte para caminho enviado: nu",
      );
    });
    expect(unsupported.terminal.terminal.paste).not.toHaveBeenCalled();
  });
});
