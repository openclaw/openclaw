export function formatLocalEnvelopeTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);

  const pick = (type: string) => parts.find((part) => part.type === type)?.value;
  const yyyy = pick("year");
  const mm = pick("month");
  const dd = pick("day");
  const hh = pick("hour");
  const min = pick("minute");
  const tz = [...parts]
    .reverse()
    .find((part) => part.type === "timeZoneName")
    ?.value?.trim();

  if (!yyyy || !mm || !dd || !hh || !min) {
    throw new Error("Missing date parts for envelope timestamp formatting.");
  }

  return `${yyyy}-${mm}-${dd} ${hh}:${min}${tz ? ` ${tz}` : ""}`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
