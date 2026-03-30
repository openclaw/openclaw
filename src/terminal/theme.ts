import chalk, { Chalk } from "chalk";
import { NEXUS_PALETTE } from "./palette.js";

const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;

const hex = (value: string) => baseChalk.hex(value);

export const theme = {
  accent: hex(NEXUS_PALETTE.accent),
  accentBright: hex(NEXUS_PALETTE.accentBright),
  accentDim: hex(NEXUS_PALETTE.accentDim),
  info: hex(NEXUS_PALETTE.info),
  success: hex(NEXUS_PALETTE.success),
  warn: hex(NEXUS_PALETTE.warn),
  error: hex(NEXUS_PALETTE.error),
  muted: hex(NEXUS_PALETTE.muted),
  heading: baseChalk.bold.hex(NEXUS_PALETTE.accent),
  command: hex(NEXUS_PALETTE.accentBright),
  option: hex(NEXUS_PALETTE.warn),
} as const;

export const isRich = () => Boolean(baseChalk.level > 0);

export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;
