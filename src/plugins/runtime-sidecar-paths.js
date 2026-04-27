import bundledRuntimeSidecarPaths from "../../scripts/lib/bundled-runtime-sidecar-paths.json" with { type: "json" };
export function assertUniqueValues(values, label) {
    const seen = new Set();
    const duplicates = new Set();
    for (const value of values) {
        if (seen.has(value)) {
            duplicates.add(value);
            continue;
        }
        seen.add(value);
    }
    if (duplicates.size > 0) {
        throw new Error(`Duplicate ${label}: ${Array.from(duplicates).join(", ")}`);
    }
    return values;
}
export const BUNDLED_RUNTIME_SIDECAR_PATHS = assertUniqueValues(bundledRuntimeSidecarPaths, "bundled runtime sidecar path");
