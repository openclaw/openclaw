import type { Command } from "commander";
type JsonMode = "output" | "parse-only";
export declare function setCommandJsonMode(command: Command, mode: JsonMode): Command;
export declare function getCommandJsonMode(command: Command, argv?: string[]): JsonMode | null;
export declare function isCommandJsonOutputMode(command: Command, argv?: string[]): boolean;
export {};
