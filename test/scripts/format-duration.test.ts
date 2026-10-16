import { expect, it } from "vitest";
import { formatDurationElapsed } from "../../scripts/lib/format-duration.mts";
import { execNodeEvalSync } from "../../src/test-utils/node-process.js";

it("loads through native Node TypeScript stripping", () => {
  const output = execNodeEvalSync(
    'import { formatDurationElapsed } from "./scripts/lib/format-duration.mts"; process.stdout.write(formatDurationElapsed(1_234));',
  );
  expect(output).toBe("1.2s");
});

type Options = NonNullable<Parameters<typeof formatDurationElapsed>[1]>;
it.each<[number, Options, string]>([
  [0, {}, "0ms"],
  [1_000, {}, "1s"],
  [1_100, { secondsDecimalDigits: 2 }, "1.10s"],
  [1_230, { secondsDecimalDigits: 2 }, "1.23s"],
  [3_100, {}, "3.1s"],
  [60_000, {}, "1m"],
  [86_400_100, {}, "1d 0.1s"],
  [31_626_061_100, {}, "1y 1d 1h 1m 1.1s"],
  [31_622_401_000, { showYears: false, unitCount: 2 }, "366d 1s"],
  [60_100, { unitCount: 1 }, "1m"],
])("formats %dms with %j as %s", (input, options, expected) => {
  expect(formatDurationElapsed(input, options)).toBe(expected);
});
