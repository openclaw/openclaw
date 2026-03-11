export const PILOT_PROJECT_STORAGE_KEY = "openclaw.pilot.project.setup.v1";

export interface PilotProjectRecord {
  parcelId: string;
  address: string;
  projectScope: string;
  projectType: string;
  objectives: string[];
  inferredJurisdiction: string;
  createdAtIso: string;
}

function resolveStorage(storage: Storage | null | undefined): Storage | null {
  if (storage !== undefined) {
    return storage;
  }
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage;
}

function isProjectRecord(value: unknown): value is PilotProjectRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<PilotProjectRecord>;
  return (
    typeof record.parcelId === "string" &&
    typeof record.address === "string" &&
    typeof record.projectScope === "string" &&
    typeof record.projectType === "string" &&
    Array.isArray(record.objectives) &&
    record.objectives.every((item) => typeof item === "string") &&
    typeof record.inferredJurisdiction === "string" &&
    typeof record.createdAtIso === "string"
  );
}

export function inferJurisdictionFromAddress(address: string): string {
  const match = address.match(/,\s*([^,]+)\s*,\s*([A-Za-z]{2})\s*$/);
  if (!match) {
    return "Pending address verification";
  }
  return `${match[1].trim()}, ${match[2].trim().toUpperCase()}`;
}

export function readPilotProjectRecord(storage?: Storage | null): PilotProjectRecord | null {
  const activeStorage = resolveStorage(storage);
  if (!activeStorage) {
    return null;
  }
  const raw = activeStorage.getItem(PILOT_PROJECT_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isProjectRecord(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writePilotProjectRecord(record: PilotProjectRecord, storage?: Storage | null) {
  const activeStorage = resolveStorage(storage);
  if (!activeStorage) {
    return;
  }
  activeStorage.setItem(PILOT_PROJECT_STORAGE_KEY, JSON.stringify(record));
}

export function clearPilotProjectRecord(storage?: Storage | null) {
  const activeStorage = resolveStorage(storage);
  if (!activeStorage) {
    return;
  }
  activeStorage.removeItem(PILOT_PROJECT_STORAGE_KEY);
}
