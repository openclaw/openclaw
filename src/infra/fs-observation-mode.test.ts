import { expect, it } from "vitest";
import { resolveFsObservationIntervalMs, resolveFsObservationMode } from "./fs-observation-mode.js";

it.each([
  [undefined, "auto"],
  ["true", "poll"],
  ["1", "poll"],
  ["yes", "poll"],
  ["off", "poll"],
  ["FALSE", "auto"],
  ["0", "auto"],
  ["", "auto"],
] as const)("preserves the polling environment override %j", (value, mode) => {
  expect(resolveFsObservationMode({ CHOKIDAR_USEPOLLING: value })).toBe(mode);
});

it.each([
  [undefined, undefined, 100],
  ["invalid", undefined, 100],
  ["0", undefined, 100],
  ["-1", undefined, 100],
  ["1", undefined, 20],
  ["250", undefined, 250],
  ["999999999999", undefined, 2_147_483_647],
  [undefined, 30_000, 30_000],
  ["invalid", 30_000, 30_000],
  ["40", 30_000, 40],
] as const)(
  "resolves polling interval %j with default %j",
  (value, defaultIntervalMs, interval) => {
    expect(resolveFsObservationIntervalMs({ CHOKIDAR_INTERVAL: value }, defaultIntervalMs)).toBe(
      interval,
    );
  },
);
