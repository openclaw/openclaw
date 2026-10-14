import type { TerminalSessionInfo } from "../../../packages/gateway-protocol/src/schema/terminal.js";

export type TerminalSessionSummary = Omit<TerminalSessionInfo, "confined" | "owner"> & {
  owner: "conn" | `agent:${string}`;
};

export type TerminalAttachSummary = Omit<TerminalSessionSummary, "attached" | "createdAtMs"> & {
  buffer: string;
  seq: number;
};
