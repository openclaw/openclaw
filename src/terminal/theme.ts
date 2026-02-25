import chalk, { Chalk } from "chalk";
import { ACTIVI_PALETTE } from "./palette.js";

const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;

const hex = (value: string) => baseChalk.hex(value);

export const theme = {
  accent: hex(ACTIVI_PALETTE.accent),
  accentBright: hex(ACTIVI_PALETTE.accentBright),
  accentDim: hex(ACTIVI_PALETTE.accentDim),
  info: hex(ACTIVI_PALETTE.info),
  success: hex(ACTIVI_PALETTE.success),
  warn: hex(ACTIVI_PALETTE.warn),
  error: hex(ACTIVI_PALETTE.error),
  muted: hex(ACTIVI_PALETTE.muted),
  heading: baseChalk.bold.hex(ACTIVI_PALETTE.accent),
  command: hex(ACTIVI_PALETTE.accentBright),
  option: hex(ACTIVI_PALETTE.warn),
} as const;

export const isRich = () => Boolean(baseChalk.level > 0);

export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;
