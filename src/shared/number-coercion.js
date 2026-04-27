export function asFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
