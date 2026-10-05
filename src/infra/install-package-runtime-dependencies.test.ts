import { expect, it } from "vitest";
import { hasPackageRuntimeDependencies } from "./install-package-dir.js";

const cases: {
  manifest: Parameters<typeof hasPackageRuntimeDependencies>[0];
  ignored: string[];
  expected: boolean;
}[] = [
  { manifest: {}, ignored: [], expected: false },
  { manifest: { dependencies: { helper: "1.0.0" } }, ignored: [], expected: true },
  { manifest: { optionalDependencies: { helper: "1.0.0" } }, ignored: [], expected: true },
  { manifest: { peerDependencies: { helper: "1.0.0" } }, ignored: [], expected: true },
  {
    manifest: {
      peerDependencies: { helper: "1.0.0" },
      peerDependenciesMeta: { helper: { optional: true } },
    },
    ignored: [],
    expected: false,
  },
  {
    manifest: {
      peerDependencies: { optionalHelper: "1.0.0", requiredHelper: "1.0.0" },
      peerDependenciesMeta: { optionalHelper: { optional: true } },
    },
    ignored: [],
    expected: true,
  },
  { manifest: { peerDependencies: { openclaw: "*" } }, ignored: [], expected: true },
  { manifest: { peerDependencies: { openclaw: "*" } }, ignored: ["openclaw"], expected: false },
  {
    manifest: { peerDependencies: { openclaw: "*", helper: "1.0.0" } },
    ignored: ["openclaw"],
    expected: true,
  },
];

it.each(cases)(
  "detects installable runtime requirements: $manifest / $ignored",
  ({ manifest, ignored, expected }) => {
    expect(hasPackageRuntimeDependencies(manifest, ignored)).toBe(expected);
  },
);
