import type { TerminalSessionInfo } from "../../../packages/gateway-protocol/src/schema/terminal.js";

export type TerminalSessionSummary = Omit<TerminalSessionInfo, "confined" | "owner"> & {
  owner: "conn" | `agent:${string}`;
};

export type TerminalAttachSummary = Omit<TerminalSessionSummary, "attached" | "createdAtMs"> & {
  buffer: string;
  seq: number;
};

export const TERMINAL_EVENT_DATA = "terminal.data" as const;
export const TERMINAL_EVENT_EXIT = "terminal.exit" as const;
