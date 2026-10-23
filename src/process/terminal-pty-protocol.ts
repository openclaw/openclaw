import type { TerminalPtySpawnParams } from "./terminal-pty.js";

export type TerminalPtyControl =
  | { type: "start"; params: TerminalPtySpawnParams }
  | { type: "prepare"; params: TerminalPtySpawnParams }
  | { type: "launch" }
  | { type: "input"; data: string }
  | { type: "input"; dataBase64: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "kill"; signal?: string };

export type TerminalPtyEvent =
  | { type: "boot" }
  | { type: "prepared" }
  | { type: "ready"; pid: number }
  | { type: "error"; message: string }
  | { type: "exit"; exitCode: number; signal?: number };
