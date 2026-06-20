import { describe, expect, it, vi } from "vitest";
import { loadProjects, restoreProject, type ProjectsState } from "./projects.ts";

function createState(
  request: (method: string, params: unknown) => Promise<unknown>,
): ProjectsState {
  return {
    client: { request } as never,
    connected: true,
    projectsLoading: false,
    projectsSaving: false,
    projectsError: null,
    projectsList: null,
    projectsSelectedId: null,
    projectsDetail: null,
    projectsContextPreview: null,
    projectsSessions: null,
    projectCreateName: "",
    projectCreateDescription: "",
    projectCreateInstructions: "",
    projectResourcePath: "",
    projectResourceName: "",
    projectResourceNote: "",
    projectSearchQuery: "",
    projectInstructionsDraft: "",
  };
}

describe("projects controller", () => {
  it("loads archived rows for recovery without auto-selecting them", async () => {
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "projects.list") {
        expect(params).toEqual({ includeArchived: true });
        return {
          ok: true,
          ts: 1,
          count: 2,
          projects: [
            {
              id: "old",
              name: "Old",
              memoryMode: "project_only",
              archived: true,
              createdAt: 1,
              updatedAt: 3,
              resources: [],
            },
            {
              id: "active",
              name: "Active",
              memoryMode: "project_only",
              createdAt: 1,
              updatedAt: 2,
              resources: [],
            },
          ],
        };
      }
      if (method === "projects.get") {
        expect(params).toMatchObject({ projectId: "active" });
        return {
          ok: true,
          project: {
            id: "active",
            name: "Active",
            memoryMode: "project_only",
            createdAt: 1,
            updatedAt: 2,
            resources: [],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const state = createState(request);

    await loadProjects(state);

    expect(state.projectsSelectedId).toBe("active");
    expect(request).toHaveBeenCalledWith("projects.list", { includeArchived: true });
  });

  it("restores archived projects and selects the recovered project", async () => {
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "projects.restore") {
        expect(params).toEqual({ projectId: "old" });
        return {
          ok: true,
          project: {
            id: "old",
            name: "Old",
            memoryMode: "project_only",
            createdAt: 1,
            updatedAt: 4,
            resources: [],
          },
        };
      }
      if (method === "projects.list") {
        return {
          ok: true,
          ts: 4,
          count: 1,
          projects: [
            {
              id: "old",
              name: "Old",
              memoryMode: "project_only",
              createdAt: 1,
              updatedAt: 4,
              resources: [],
            },
          ],
        };
      }
      if (method === "projects.get") {
        return {
          ok: true,
          project: {
            id: "old",
            name: "Old",
            memoryMode: "project_only",
            createdAt: 1,
            updatedAt: 4,
            resources: [],
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const state = createState(request);

    await restoreProject(state, "old");

    expect(state.projectsSelectedId).toBe("old");
    expect(request).toHaveBeenCalledWith("projects.restore", { projectId: "old" });
  });
});
