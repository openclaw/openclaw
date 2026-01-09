import chalk, { Chalk } from "chalk";

import { LOBSTER_PALETTE } from "./palette.js";

const baseChalk = process.env.NO_COLOR ? new Chalk({ level: 0 }) : chalk;

const hex = (value: string) => baseChalk.hex(value);

export const theme = {
  accent: hex(LOBSTER_PALETTE.accent),
  accentBright: hex(LOBSTER_PALETTE.accentBright),
  accentDim: hex(LOBSTER_PALETTE.accentDim),
  info: hex(LOBSTER_PALETTE.info),
  success: hex(LOBSTER_PALETTE.success),
  warn: hex(LOBSTER_PALETTE.warn),
  error: hex(LOBSTER_PALETTE.error),
  muted: hex(LOBSTER_PALETTE.muted),
  heading: baseChalk.bold.hex(LOBSTER_PALETTE.accent),
  command: hex(LOBSTER_PALETTE.accentBright),
  option: hex(LOBSTER_PALETTE.warn),
} as const;

export const isRich = () =>
  Boolean(process.stdout.isTTY && baseChalk.level > 0);

export const colorize = (
  rich: boolean,
  color: (value: string) => string,
  value: string,
) => (rich ? color(value) : value);
