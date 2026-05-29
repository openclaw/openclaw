export function resolveNonNegativeIntegerOption(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

export function resolveIntegerOption(
  value: number,
  fallback: number,
  params: { min: number },
): number {
  const candidate = Number.isFinite(value) ? value : fallback;
  return Math.max(params.min, Math.floor(candidate));
}
