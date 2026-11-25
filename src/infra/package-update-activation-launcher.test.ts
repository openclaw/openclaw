import { expect, it } from "vitest";
import { matchesPackageActivationLauncher } from "./package-update-activation-launcher.js";

it.each([
  { name: "symlink mode drift", type: "symlink", mode: 0o120700, matches: true },
  {
    name: "symlink target drift",
    type: "symlink",
    mode: 0o120700,
    contents: "../lib/node_modules/other/openclaw.mjs",
    matches: false,
  },
  { name: "launcher type drift", type: "file", mode: 0o100755, matches: false },
  {
    name: "regular-file mode drift",
    type: "file",
    expectedType: "file",
    mode: 0o100700,
    matches: false,
  },
] as const)("checks recorded launcher integrity for $name", (scenario) => {
  const expectedType = scenario.expectedType ?? "symlink";
  const contents = "../lib/node_modules/openclaw/openclaw.mjs";
  const recorded = JSON.stringify([
    expectedType,
    String(expectedType === "file" ? 0o100755 : 0o120755),
    "501",
    "80",
    contents,
  ]);
  expect(
    matchesPackageActivationLauncher(
      {
        type: scenario.type,
        mode: String(scenario.mode),
        uid: "501",
        gid: "80",
        contents: scenario.contents ?? contents,
      },
      recorded,
    ),
  ).toBe(scenario.matches);
});
