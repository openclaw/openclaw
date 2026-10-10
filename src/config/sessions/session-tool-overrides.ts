import { stableStringify } from "@openclaw/normalization-core/stable-stringify";

export type SessionToolOverrides = {
  mcpServers?: Record<string, boolean>;
  mcpToolsDeny?: Record<string, string[]>;
  skills?: Record<string, boolean>;
  webSearch?: boolean;
};

export function normalizeMcpToolDenials(
  value?: Record<string, string[]>,
): Record<string, string[]> | undefined {
  const entries = Object.entries(value ?? {})
    .map(
      ([serverName, toolNames]) =>
        [
          serverName,
          [...new Set(toolNames)].toSorted((left, right) => left.localeCompare(right)),
        ] as const,
    )
    .filter(([, toolNames]) => toolNames.length > 0)
    .toSorted(([left], [right]) => left.localeCompare(right));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizeSessionToolOverrides(
  raw: SessionToolOverrides | null | undefined,
): SessionToolOverrides | undefined {
  if (!raw) {
    return undefined;
  }
  const normalizeBooleanMap = (value: Record<string, boolean> | undefined) => {
    const entries = Object.entries(value ?? {}).toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  };
  const mcpToolsDeny = normalizeMcpToolDenials(raw.mcpToolsDeny);
  const mcpServers = normalizeBooleanMap(raw.mcpServers);
  const skills = normalizeBooleanMap(raw.skills);
  // Keep both booleans. An explicit enable must persist the same way skills
  // and mcpServers do; only non-booleans are dropped. Deny remains false.
  const normalized: SessionToolOverrides = {
    ...(mcpServers ? { mcpServers } : {}),
    ...(mcpToolsDeny ? { mcpToolsDeny } : {}),
    ...(skills ? { skills } : {}),
    ...(typeof raw.webSearch === "boolean" ? { webSearch: raw.webSearch } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Compare sparse tool policy overlays by their canonical stored meaning. */
export function sessionToolOverridesEqual(
  left: SessionToolOverrides | null | undefined,
  right: SessionToolOverrides | null | undefined,
): boolean {
  return (
    stableStringify(normalizeSessionToolOverrides(left)) ===
    stableStringify(normalizeSessionToolOverrides(right))
  );
}

/** Retained enables require both owners; either owner can deny a capability. */
export function intersectSessionToolOverrides(
  retained: SessionToolOverrides | undefined,
  current: SessionToolOverrides | undefined,
): SessionToolOverrides | undefined {
  const intersectMap = (left: Record<string, boolean> = {}, right: Record<string, boolean> = {}) =>
    Object.fromEntries(
      [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) =>
        left[key] === false || right[key] === false
          ? [[key, false]]
          : left[key] === true && right[key] === true
            ? [[key, true]]
            : [],
      ),
    );
  const deniedServers = new Set([
    ...Object.keys(retained?.mcpToolsDeny ?? {}),
    ...Object.keys(current?.mcpToolsDeny ?? {}),
  ]);
  return normalizeSessionToolOverrides({
    mcpServers: intersectMap(retained?.mcpServers, current?.mcpServers),
    skills: intersectMap(retained?.skills, current?.skills),
    mcpToolsDeny: Object.fromEntries(
      [...deniedServers].map((server) => [
        server,
        [...(retained?.mcpToolsDeny?.[server] ?? []), ...(current?.mcpToolsDeny?.[server] ?? [])],
      ]),
    ),
    webSearch: retained?.webSearch === false || current?.webSearch === false ? false : undefined,
  });
}
