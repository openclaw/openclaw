import { vi } from "vitest";
import type { TerminalUploadResult } from "../../../packages/gateway-protocol/src/index.js";
import type { TerminalSessionSummary } from "../terminal/session-types.js";

export function makeTerminalSessionMocks() {
  return {
    open: vi.fn(async (_request: unknown) => ({
      ok: true as const,
      sessionId: "terminal-1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
    })),
    write: vi.fn(() => true),
    resize: vi.fn(() => true),
    close: vi.fn(() => true),
    attach: vi.fn(() => ({
      sessionId: "terminal-1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      buffer: "replay",
      seq: 6,
      title: "codex",
      owner: "conn" as const,
    })),
    snapshot: vi.fn(() => "10%\r100%"),
    list: vi.fn((): TerminalSessionSummary[] => []),
    upload: vi.fn(async (): Promise<TerminalUploadResult> => ({
      path: "/tmp/upload/report.pdf",
      size: 4,
    })),
  };
}
