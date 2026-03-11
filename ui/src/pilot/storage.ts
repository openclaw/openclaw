export type SourceHealth = "validated" | "revalidation" | "blocked";

export type PilotJurisdiction = {
  id: string;
  name: string;
  sourceHealth: SourceHealth;
  blockedFamily: string | null;
  updatedAt: string;
};

export type PilotParcel = {
  id: string;
  parcelId: string;
  address: string;
  jurisdictionId: string;
  createdAt: string;
};

export type PilotProject = {
  id: string;
  name: string;
  scope: string;
  parcelId: string;
  parcelRecordId: string;
  jurisdictionId: string;
  status: "active" | "review" | "blocked";
  createdAt: string;
};

type PilotSnapshot = {
  jurisdictions: PilotJurisdiction[];
  parcels: PilotParcel[];
  projects: PilotProject[];
};

const STORAGE_KEYS = {
  jurisdictions: "openclaw.pilot.jurisdictions",
  parcels: "openclaw.pilot.parcels",
  projects: "openclaw.pilot.projects",
} as const;

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultSnapshot(): PilotSnapshot {
  const austinId = "jurisdiction-austin";
  const travisId = "jurisdiction-travis";
  const roundRockId = "jurisdiction-round-rock";
  return {
    jurisdictions: [
      {
        id: austinId,
        name: "Austin, TX",
        sourceHealth: "validated",
        blockedFamily: null,
        updatedAt: nowIso(),
      },
      {
        id: travisId,
        name: "Travis County, TX",
        sourceHealth: "revalidation",
        blockedFamily: null,
        updatedAt: nowIso(),
      },
      {
        id: roundRockId,
        name: "Round Rock, TX",
        sourceHealth: "blocked",
        blockedFamily: "zoning maps",
        updatedAt: nowIso(),
      },
    ],
    parcels: [
      {
        id: "parcel-seed-1",
        parcelId: "17-0821-0010",
        address: "1200 E 6th St, Austin, TX",
        jurisdictionId: austinId,
        createdAt: nowIso(),
      },
    ],
    projects: [
      {
        id: "project-seed-1",
        name: "1200 E 6th St Due Diligence",
        scope: "Mixed-use entitlement due diligence",
        parcelId: "17-0821-0010",
        parcelRecordId: "parcel-seed-1",
        jurisdictionId: austinId,
        status: "active",
        createdAt: nowIso(),
      },
    ],
  };
}

function canUseStorage() {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

function readList<T>(key: string) {
  if (!canUseStorage()) {
    return [] as T[];
  }
  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return [] as T[];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeList<T>(key: string, value: T[]) {
  if (!canUseStorage()) {
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function loadPilotSnapshot(): PilotSnapshot {
  const jurisdictions = readList<PilotJurisdiction>(STORAGE_KEYS.jurisdictions);
  const parcels = readList<PilotParcel>(STORAGE_KEYS.parcels);
  const projects = readList<PilotProject>(STORAGE_KEYS.projects);
  if (jurisdictions.length > 0 || parcels.length > 0 || projects.length > 0) {
    return { jurisdictions, parcels, projects };
  }
  const seeded = defaultSnapshot();
  persistPilotSnapshot(seeded);
  return seeded;
}

export function persistPilotSnapshot(snapshot: PilotSnapshot) {
  writeList(STORAGE_KEYS.jurisdictions, snapshot.jurisdictions);
  writeList(STORAGE_KEYS.parcels, snapshot.parcels);
  writeList(STORAGE_KEYS.projects, snapshot.projects);
}

function normalizeAddress(value: string) {
  return value.trim().toLowerCase();
}

export function inferJurisdictionName(address: string) {
  const normalized = normalizeAddress(address);
  if (normalized.includes("austin")) {
    return "Austin, TX";
  }
  if (normalized.includes("round rock")) {
    return "Round Rock, TX";
  }
  if (normalized.includes("travis")) {
    return "Travis County, TX";
  }
  if (normalized.includes("houston")) {
    return "Houston, TX";
  }
  return "Unresolved jurisdiction";
}

export function createPilotProject(input: { parcelId: string; address: string; scope: string }) {
  const snapshot = loadPilotSnapshot();
  const jurisdictionName = inferJurisdictionName(input.address);
  let jurisdiction =
    snapshot.jurisdictions.find((entry) => entry.name === jurisdictionName) ?? null;
  if (!jurisdiction) {
    jurisdiction = {
      id: createId("jurisdiction"),
      name: jurisdictionName,
      sourceHealth: jurisdictionName === "Unresolved jurisdiction" ? "blocked" : "validated",
      blockedFamily: jurisdictionName === "Unresolved jurisdiction" ? "jurisdiction lookup" : null,
      updatedAt: nowIso(),
    };
    snapshot.jurisdictions.unshift(jurisdiction);
  }
  const parcel: PilotParcel = {
    id: createId("parcel"),
    parcelId: input.parcelId.trim(),
    address: input.address.trim(),
    jurisdictionId: jurisdiction.id,
    createdAt: nowIso(),
  };
  const project: PilotProject = {
    id: createId("project"),
    name: `${input.parcelId.trim()} pilot project`,
    scope: input.scope.trim(),
    parcelId: input.parcelId.trim(),
    parcelRecordId: parcel.id,
    jurisdictionId: jurisdiction.id,
    status: jurisdiction.sourceHealth === "blocked" ? "blocked" : "active",
    createdAt: nowIso(),
  };
  snapshot.parcels.unshift(parcel);
  snapshot.projects.unshift(project);
  persistPilotSnapshot(snapshot);
  return { project, parcel, jurisdiction, snapshot };
}

export function getPilotProject(projectId: string) {
  const snapshot = loadPilotSnapshot();
  const project = snapshot.projects.find((entry) => entry.id === projectId) ?? null;
  if (!project) {
    return null;
  }
  const parcel = snapshot.parcels.find((entry) => entry.id === project.parcelRecordId) ?? null;
  const jurisdiction =
    snapshot.jurisdictions.find((entry) => entry.id === project.jurisdictionId) ?? null;
  return { project, parcel, jurisdiction, snapshot };
}
