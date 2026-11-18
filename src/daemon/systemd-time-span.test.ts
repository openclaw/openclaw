import { expect, it } from "vitest";
import { parseSystemdTimeSpanMs } from "./systemd-time-span.js";

it.each([
  ["1min 30s", 90_000],
  ["5min 30s", 330_000],
  ["330", 330_000],
  ["1h 2min 3.5s 4ms 5us", 3_723_504.005],
  ["1ms", 1],
  ["0", 0],
  ["infinity", Infinity],
  ["", undefined],
  ["-1", undefined],
  ["NaN", undefined],
  ["90 seconds junk", undefined],
  ["1M", 2_629_800_000],
])("parses systemd time span %s", (value, expected) => {
  expect(parseSystemdTimeSpanMs(value)).toBe(expected);
});
