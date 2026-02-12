import chalk, { Chalk } from "chalk";
import { IRON_PALETTE } from "./palette.js";

const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;

const hex = (value: string) => baseChalk.hex(value);

export const theme = {
  accent: hex(IRON_PALETTE.accent),
  accentBright: hex(IRON_PALETTE.accentBright),
  accentDim: hex(IRON_PALETTE.accentDim),
  info: hex(IRON_PALETTE.info),
  success: hex(IRON_PALETTE.success),
  warn: hex(IRON_PALETTE.warn),
  error: hex(IRON_PALETTE.error),
  muted: hex(IRON_PALETTE.muted),
  heading: baseChalk.bold.hex(IRON_PALETTE.accent),
  command: hex(IRON_PALETTE.accentBright),
  option: hex(IRON_PALETTE.warn),
} as const;

export const isRich = () => Boolean(baseChalk.level > 0);

export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;
