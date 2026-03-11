import { describe, expect, it } from "vitest";
import {
  bindPilotContextToMessage,
  buildPilotWorkspaceHref,
  clearPilotProjects,
  createPilotProject,
  findPilotProjectBySessionKey,
  inferPilotJurisdiction,
  listPilotProjects,
  loadActivePilotProject,
  setActivePilotProject,
  type PilotStorageLike,
} from "./storage.ts";

function createStorageMock(): PilotStorageLike {
  const map = new Map<string, string>();
  return {
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
  };
}

describe("pilot storage", () => {
  it("creates and persists a project as active", () => {
    const storage = createStorageMock();

    const project = createPilotProject(
      {
        parcelId: "APN 123-456-789",
        siteAddress: "100 Main St, Austin, TX",
        scope: "Civil entitlement due diligence",
      },
      {
        storage,
        now: () => Date.UTC(2026, 2, 11, 8, 0, 0),
        randomId: () => "ABC-123",
      },
    );

    expect(project.id).toMatch(/^pilot-[a-z0-9]+-abc-123$/);
    expect(project.sessionKey).toBe(`pilot:${project.id}`);
    expect(project.inferredJurisdiction).toBe("Austin, TX");

    const listed = listPilotProjects({ storage });
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(project.id);

    const active = loadActivePilotProject({ storage });
    expect(active?.id).toBe(project.id);
  });

  it("can switch active projects and resolve by session key", () => {
    const storage = createStorageMock();

    const first = createPilotProject(
      {
        parcelId: "APN 111-111-111",
        siteAddress: "10 River Rd, Dallas, TX",
        scope: "Floodplain screening",
      },
      {
        storage,
        now: () => Date.UTC(2026, 2, 10, 8, 0, 0),
        randomId: () => "first-project",
      },
    );

    const second = createPilotProject(
      {
        parcelId: "APN 222-222-222",
        siteAddress: "50 Lake Ave, Houston, TX",
        scope: "Site utility due diligence",
      },
      {
        storage,
        now: () => Date.UTC(2026, 2, 11, 8, 0, 0),
        randomId: () => "second-project",
      },
    );

    expect(loadActivePilotProject({ storage })?.id).toBe(second.id);
    expect(setActivePilotProject(first.id, { storage })).toBe(true);
    expect(loadActivePilotProject({ storage })?.id).toBe(first.id);

    const resolved = findPilotProjectBySessionKey(first.sessionKey, { storage });
    expect(resolved?.parcelId).toBe("APN 111-111-111");
  });

  it("builds workspace links and bound context payloads", () => {
    const storage = createStorageMock();
    const project = createPilotProject(
      {
        parcelId: "APN 900-000-111",
        siteAddress: "100 Main St, Austin, TX",
        scope: "Civil entitlement due diligence",
      },
      {
        storage,
        now: () => Date.UTC(2026, 2, 11, 8, 0, 0),
        randomId: () => "project-link",
      },
    );

    const encodedSession = encodeURIComponent(project.sessionKey);
    expect(buildPilotWorkspaceHref(project, "chat")).toBe(`/chat?session=${encodedSession}`);
    expect(buildPilotWorkspaceHref(project, "cron")).toBe(`/cron?session=${encodedSession}`);

    const chatPayload = bindPilotContextToMessage({
      project,
      message: "Find zoning overlays and citation sources.",
      mode: "chat",
    });
    expect(chatPayload).toContain("Pilot Project Context:");
    expect(chatPayload).toContain("User request:");
    expect(chatPayload).toContain("Find zoning overlays and citation sources.");

    const runnerPayload = bindPilotContextToMessage({
      project,
      message: "Run county assessor and FEMA checks.",
      mode: "runner",
    });
    expect(runnerPayload).toContain("Runner task:");
    expect(runnerPayload).toContain("Run county assessor and FEMA checks.");

    clearPilotProjects({ storage });
    expect(listPilotProjects({ storage })).toEqual([]);
  });

  it("infers jurisdiction from address tails", () => {
    expect(inferPilotJurisdiction("100 Main St, Austin, TX")).toBe("Austin, TX");
    expect(inferPilotJurisdiction("Travis County, TX")).toBe("Travis County, TX");
    expect(inferPilotJurisdiction("   ")).toBe("Unknown jurisdiction");
  });
});
