import { compare, minVersion, Range, satisfies as satisfiesRange } from "semver";
import { SUPPORTED_NODE_VERSION_RANGE } from "../../../node-version.mjs";

export function minimumSupportedNodeVersion(engineRange: string): string | undefined {
  const candidate = new Range(engineRange);
  return new Range(SUPPORTED_NODE_VERSION_RANGE).set
    .flatMap((supported) =>
      candidate.set.flatMap((required) => {
        const intersection = [...supported, ...required].map((entry) => entry.value).join(" ");
        const minimum = minVersion(intersection);
        if (!minimum) {
          return [];
        }
        // Node's release contract excludes prereleases, even when engines allow them.
        const release = `${minimum.major}.${minimum.minor}.${minimum.patch}`;
        return satisfiesRange(release, intersection) ? [release] : [];
      }),
    )
    .toSorted(compare)[0];
}
