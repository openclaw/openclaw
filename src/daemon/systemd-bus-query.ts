import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export type SystemdBusQuery = (args: string[], signatures: string[]) => Promise<unknown[] | null>;

export function isSystemdManagerUid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 0xffffffff;
}

export function systemdUnitCallArgs(
  destination: string,
  unitName: string,
  method: "GetUnit" | "LoadUnit" | "GetUnitFileState" | "GetUnitProcesses",
): string[] {
  return [
    "call",
    destination,
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    method,
    "s",
    unitName,
  ];
}

/** Decode busctl's ordered property replies without accepting mismatched signatures. */
export function decodeSystemdBusProperties(
  output: string,
  signatures: string[],
  unavailable: () => Error,
): unknown[] {
  const properties = output
    .trim()
    .split(/\r?\n/)
    .map((line) => asOptionalRecord(JSON.parse(line)));
  if (
    properties.length !== signatures.length ||
    properties.some((property, index) => property?.type !== signatures[index])
  ) {
    throw unavailable();
  }
  return properties.map((property) => property?.data);
}

/** The caller retains its own transport, deadline, and authority checks. */
export async function readSystemdBusCall(
  query: SystemdBusQuery,
  method: string,
  args: string[],
  signature: string,
  unavailable: () => Error,
): Promise<unknown> {
  const [value] =
    (await query(
      [
        "call",
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        method,
        ...args,
      ],
      [signature],
    )) ?? [];
  if (!Array.isArray(value) || value.length !== 1) {
    throw unavailable();
  }
  return value[0];
}

export async function readSystemdBusOwner(
  query: SystemdBusQuery,
  unavailable: () => Error,
): Promise<string> {
  const owner = await readSystemdBusCall(
    query,
    "GetNameOwner",
    ["s", "org.freedesktop.systemd1"],
    "s",
    unavailable,
  );
  if (typeof owner !== "string" || !/^:[0-9]+\.[0-9]+$/.test(owner)) {
    throw unavailable();
  }
  return owner;
}

export function readSystemdUnitObjectPath(value: unknown, unavailable: () => Error): string {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    typeof value[0] !== "string" ||
    !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(value[0])
  ) {
    throw unavailable();
  }
  return value[0];
}
