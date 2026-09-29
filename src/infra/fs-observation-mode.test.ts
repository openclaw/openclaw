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
  [undefined, 100],
  ["invalid", 100],
  ["0", 100],
  ["-1", 100],
  ["1", 20],
  ["250", 250],
  ["999999999999", 2_147_483_647],
] as const)("bounds the polling interval %j", (value, interval) => {
  expect(resolveFsObservationIntervalMs({ CHOKIDAR_INTERVAL: value })).toBe(interval);
});
