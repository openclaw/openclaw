export function formatDurationCompact(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "n/a";
  }
  const minutes = Math.max(1, Math.round(valueMs / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const minutesRemainder = minutes % 60;
  if (hours < 24) {
    return minutesRemainder > 0 ? `${hours}h${minutesRemainder}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const hoursRemainder = hours % 24;
  return hoursRemainder > 0 ? `${days}d${hoursRemainder}h` : `${days}d`;
}

export function formatTokenShort(value?: number) {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const n = Math.floor(value);
  if (n < 1_000) {
    return `${n}`;
  }
  if (n < 10_000) {
    return `${(n / 1_000).toFixed(1).replace(/\\.0$/, "")}k`;
  }
  if (n < 1_000_000) {
    return `${Math.round(n / 1_000)}k`;
  }
  return `${(n / 1_000_000).toFixed(1).replace(/\\.0$/, "")}m`;
}

export function truncateLine(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength).trimEnd()}...`;
}
