export function formatTuiTimestamp(date = new Date()) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function prefixTimestamp(text: string, timestamp = formatTuiTimestamp()) {
  return `[${timestamp}] ${text}`;
}
