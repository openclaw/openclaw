export const PILOT_STORAGE_KEY = "openclaw.pilot.projects.v1";
const PILOT_STORAGE_VERSION = 1;

export type PilotStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type PilotWorkspaceTab = "chat" | "cron";

export type PilotProject = {
  id: string;
  sessionKey: string;
  parcelId: string;
  siteAddress: string;
  scope: string;
  inferredJurisdiction: string;
  createdAt: string;
};

type PilotStoreRecord = {
  version: number;
  activeProjectId: string | null;
  projects: PilotProject[];
};

export type CreatePilotProjectInput = {
  parcelId: string;
  siteAddress: string;
  scope: string;
  inferredJurisdiction?: string;
};

type ProjectCreationOptions = {
  storage?: PilotStorageLike | null;
  now?: () => number;
  randomId?: () => string;
};

const EMPTY_STORE: PilotStoreRecord = {
  version: PILOT_STORAGE_VERSION,
  activeProjectId: null,
  projects: [],
};

function resolveStorage(storage?: PilotStorageLike | null): PilotStorageLike | null {
  if (storage) {
    return storage;
  }
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function inferJurisdictionFromAddressRaw(address: string): string {
  const pieces = address
    .split(",")
    .map((piece) => normalizeText(piece))
    .filter(Boolean);
  if (pieces.length >= 2) {
    return `${pieces[pieces.length - 2]}, ${pieces[pieces.length - 1]}`;
  }
  if (pieces.length === 1) {
    return pieces[0];
  }
  return "Unknown jurisdiction";
}

export function inferPilotJurisdiction(address: string): string {
  return inferJurisdictionFromAddressRaw(normalizeText(address));
}

function normalizeProject(project: unknown): PilotProject | null {
  if (!project || typeof project !== "object") {
    return null;
  }
  const candidate = project as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? normalizeText(candidate.id) : "";
  const sessionKey =
    typeof candidate.sessionKey === "string" ? normalizeText(candidate.sessionKey) : "";
  const parcelId = typeof candidate.parcelId === "string" ? normalizeText(candidate.parcelId) : "";
  const siteAddress =
    typeof candidate.siteAddress === "string" ? normalizeText(candidate.siteAddress) : "";
  const scope = typeof candidate.scope === "string" ? normalizeText(candidate.scope) : "";
  const createdAt =
    typeof candidate.createdAt === "string" ? normalizeText(candidate.createdAt) : "";
  if (!id || !sessionKey || !parcelId || !siteAddress || !scope || !createdAt) {
    return null;
  }
  const jurisdictionRaw =
    typeof candidate.inferredJurisdiction === "string"
      ? normalizeText(candidate.inferredJurisdiction)
      : "";
  const inferredJurisdiction = jurisdictionRaw || inferJurisdictionFromAddressRaw(siteAddress);
  return {
    id,
    sessionKey,
    parcelId,
    siteAddress,
    scope,
    inferredJurisdiction,
    createdAt,
  };
}

function sortProjectsNewestFirst(projects: PilotProject[]): PilotProject[] {
  return [...projects].toSorted((left, right) => {
    const leftStamp = Date.parse(left.createdAt);
    const rightStamp = Date.parse(right.createdAt);
    return (
      (Number.isFinite(rightStamp) ? rightStamp : 0) - (Number.isFinite(leftStamp) ? leftStamp : 0)
    );
  });
}

function normalizeStore(input: unknown): PilotStoreRecord {
  if (!input || typeof input !== "object") {
    return { ...EMPTY_STORE };
  }
  const candidate = input as Record<string, unknown>;
  const projectsRaw = Array.isArray(candidate.projects) ? candidate.projects : [];
  const seen = new Set<string>();
  const projects: PilotProject[] = [];
  for (const entry of projectsRaw) {
    const normalized = normalizeProject(entry);
    if (!normalized || seen.has(normalized.id)) {
      continue;
    }
    seen.add(normalized.id);
    projects.push(normalized);
  }
  const sortedProjects = sortProjectsNewestFirst(projects);
  const activeProjectIdRaw =
    typeof candidate.activeProjectId === "string" ? normalizeText(candidate.activeProjectId) : "";
  const activeProjectId =
    activeProjectIdRaw && sortedProjects.some((project) => project.id === activeProjectIdRaw)
      ? activeProjectIdRaw
      : (sortedProjects[0]?.id ?? null);
  return {
    version: PILOT_STORAGE_VERSION,
    activeProjectId,
    projects: sortedProjects,
  };
}

function loadStore(storage?: PilotStorageLike | null): PilotStoreRecord {
  const resolved = resolveStorage(storage);
  if (!resolved) {
    return { ...EMPTY_STORE };
  }
  const raw = resolved.getItem(PILOT_STORAGE_KEY);
  if (!raw) {
    return { ...EMPTY_STORE };
  }
  try {
    return normalizeStore(JSON.parse(raw));
  } catch {
    return { ...EMPTY_STORE };
  }
}

function saveStore(store: PilotStoreRecord, storage?: PilotStorageLike | null) {
  const resolved = resolveStorage(storage);
  if (!resolved) {
    return;
  }
  resolved.setItem(PILOT_STORAGE_KEY, JSON.stringify(normalizeStore(store)));
}

function fallbackRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function normalizeProjectId(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `pilot-${Date.now().toString(36)}`;
}

function buildProjectId(nowMs: number, randomId: string): string {
  const timestamp = Math.max(0, Math.floor(nowMs)).toString(36);
  const suffix = normalizeProjectId(randomId).slice(0, 24);
  return `pilot-${timestamp}-${suffix}`;
}

export function listPilotProjects(options?: { storage?: PilotStorageLike | null }): PilotProject[] {
  return loadStore(options?.storage).projects;
}

export function loadActivePilotProject(options?: {
  storage?: PilotStorageLike | null;
}): PilotProject | null {
  const store = loadStore(options?.storage);
  if (!store.activeProjectId) {
    return store.projects[0] ?? null;
  }
  return (
    store.projects.find((project) => project.id === store.activeProjectId) ??
    store.projects[0] ??
    null
  );
}

export function setActivePilotProject(
  projectId: string,
  options?: {
    storage?: PilotStorageLike | null;
  },
): boolean {
  const trimmed = normalizeText(projectId);
  if (!trimmed) {
    return false;
  }
  const store = loadStore(options?.storage);
  if (!store.projects.some((project) => project.id === trimmed)) {
    return false;
  }
  store.activeProjectId = trimmed;
  saveStore(store, options?.storage);
  return true;
}

export function createPilotProject(
  input: CreatePilotProjectInput,
  options?: ProjectCreationOptions,
): PilotProject {
  const parcelId = normalizeText(input.parcelId);
  const siteAddress = normalizeText(input.siteAddress);
  const scope = normalizeText(input.scope);
  const inferredJurisdiction = normalizeText(input.inferredJurisdiction ?? "");

  if (!parcelId) {
    throw new Error("Parcel ID is required.");
  }
  if (!siteAddress) {
    throw new Error("Site address is required.");
  }
  if (!scope) {
    throw new Error("Project scope is required.");
  }

  const nowMs = options?.now ? options.now() : Date.now();
  const randomPart = options?.randomId ? options.randomId() : fallbackRandomId();
  const id = buildProjectId(nowMs, randomPart);
  const sessionKey = `pilot:${id}`;
  const project: PilotProject = {
    id,
    sessionKey,
    parcelId,
    siteAddress,
    scope,
    inferredJurisdiction: inferredJurisdiction || inferJurisdictionFromAddressRaw(siteAddress),
    createdAt: new Date(nowMs).toISOString(),
  };

  const store = loadStore(options?.storage);
  store.projects = sortProjectsNewestFirst([
    project,
    ...store.projects.filter((entry) => entry.id !== project.id),
  ]);
  store.activeProjectId = project.id;
  saveStore(store, options?.storage);
  return project;
}

export function findPilotProjectBySessionKey(
  sessionKey: string,
  options?: { storage?: PilotStorageLike | null },
): PilotProject | null {
  const normalized = normalizeText(sessionKey);
  if (!normalized) {
    return null;
  }
  return (
    loadStore(options?.storage).projects.find((project) => project.sessionKey === normalized) ??
    null
  );
}

export function buildPilotWorkspaceHref(project: PilotProject, tab: PilotWorkspaceTab): string {
  const path = tab === "cron" ? "/cron" : "/chat";
  return `${path}?session=${encodeURIComponent(project.sessionKey)}`;
}

export function buildPilotContextBlock(project: PilotProject): string {
  return [
    "Pilot Project Context:",
    `- Project ID: ${project.id}`,
    `- Session Key: ${project.sessionKey}`,
    `- Parcel ID: ${project.parcelId}`,
    `- Site Address: ${project.siteAddress}`,
    `- Jurisdiction: ${project.inferredJurisdiction}`,
    `- Scope: ${project.scope}`,
    "- Source of truth: Moore Bass pilot intake form",
  ].join("\n");
}

export function bindPilotContextToMessage(params: {
  project: PilotProject;
  message: string;
  mode: "chat" | "runner";
}): string {
  const body = normalizeText(params.message);
  const context = buildPilotContextBlock(params.project);
  const modeLabel = params.mode === "runner" ? "Runner task" : "User request";
  if (!body) {
    return context;
  }
  return `${context}\n\n${modeLabel}:\n${body}`;
}

export function clearPilotProjects(options?: { storage?: PilotStorageLike | null }) {
  const storage = resolveStorage(options?.storage);
  storage?.removeItem(PILOT_STORAGE_KEY);
}
