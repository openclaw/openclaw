import chalk, { Chalk } from "chalk";
import { BOT_PALETTE } from "./palette.js";

const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;

const hex = (value: string) => baseChalk.hex(value);

export const theme = {
  accent: hex(BOT_PALETTE.accent),
  accentBright: hex(BOT_PALETTE.accentBright),
  accentDim: hex(BOT_PALETTE.accentDim),
  info: hex(BOT_PALETTE.info),
  success: hex(BOT_PALETTE.success),
  warn: hex(BOT_PALETTE.warn),
  warning: hex(BOT_PALETTE.warn),
  error: hex(BOT_PALETTE.error),
  muted: hex(BOT_PALETTE.muted),
  bold: baseChalk.bold,
  heading: baseChalk.bold.hex(BOT_PALETTE.accent),
  command: hex(BOT_PALETTE.accentBright),
  option: hex(BOT_PALETTE.warn),
} as const;

export const isRich = () => Boolean(baseChalk.level > 0);

export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;
