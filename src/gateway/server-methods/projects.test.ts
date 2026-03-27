import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardIndex, ProjectIndex, QueueIndex } from "../../projects/sync-types.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

// Import the handler module and its setter
import { projectsHandlers, setProjectsService } from "./projects.js";

describe("projectsHandlers", () => {
  const mockListProjects = vi.fn<() => Promise<Array<{ name: string } & ProjectIndex>>>();
  const mockGetProject = vi.fn<(name: string) => Promise<ProjectIndex | null>>();
  const mockGetBoard = vi.fn<(name: string) => Promise<BoardIndex | null>>();
  const mockGetQueue = vi.fn<(name: string) => Promise<QueueIndex | null>>();

  let respond: RespondFn;
  let respondCalls: Array<{ ok: boolean; payload?: unknown; error?: unknown }>;

  beforeEach(() => {
    respondCalls = [];
    respond = (ok, payload, error) => {
      respondCalls.push({ ok, payload, error });
    };
    // Set up the mock service
    setProjectsService({
      listProjects: mockListProjects,
      getProject: mockGetProject,
      getBoard: mockGetBoard,
      getQueue: mockGetQueue,
    } as never);
    vi.clearAllMocks();
  });

  afterEach(() => {
    setProjectsService(null as never);
  });

  function makeOpts(params: Record<string, unknown>): GatewayRequestHandlerOptions {
    return {
      req: {} as never,
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    };
  }

  describe("projects.list", () => {
    it("calls listProjects() and responds with { projects: [...] }", async () => {
      const projects = [
        { name: "alpha", status: "active", indexedAt: "2026-01-01T00:00:00Z" },
      ] as Array<{ name: string } & ProjectIndex>;
      mockListProjects.mockResolvedValueOnce(projects);

      await projectsHandlers["projects.list"]!(makeOpts({}));

      expect(mockListProjects).toHaveBeenCalledOnce();
      expect(respondCalls).toEqual([{ ok: true, payload: { projects }, error: undefined }]);
    });
  });

  describe("projects.get", () => {
    it("with valid params.project calls getProject() and responds with { project }", async () => {
      const project = {
        name: "alpha",
        status: "active",
        indexedAt: "2026-01-01T00:00:00Z",
      } as ProjectIndex;
      mockGetProject.mockResolvedValueOnce(project);

      await projectsHandlers["projects.get"]!(makeOpts({ project: "alpha" }));

      expect(mockGetProject).toHaveBeenCalledWith("alpha");
      expect(respondCalls).toEqual([{ ok: true, payload: { project }, error: undefined }]);
    });

    it("with missing params.project responds with error", async () => {
      await projectsHandlers["projects.get"]!(makeOpts({}));

      expect(respondCalls).toHaveLength(1);
      expect(respondCalls[0]!.ok).toBe(false);
      expect(respondCalls[0]!.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("missing required param: project"),
      });
    });

    it("when getProject() returns null responds with error", async () => {
      mockGetProject.mockResolvedValueOnce(null);

      await projectsHandlers["projects.get"]!(makeOpts({ project: "gone" }));

      expect(respondCalls).toHaveLength(1);
      expect(respondCalls[0]!.ok).toBe(false);
      expect(respondCalls[0]!.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: "project not found: gone",
      });
    });
  });

  describe("projects.board.get", () => {
    it("with valid params.project calls getBoard() and responds with { board }", async () => {
      const board: BoardIndex = {
        columns: [{ name: "Backlog", tasks: [] }],
        indexedAt: "2026-01-01T00:00:00Z",
      };
      mockGetBoard.mockResolvedValueOnce(board);

      await projectsHandlers["projects.board.get"]!(makeOpts({ project: "alpha" }));

      expect(mockGetBoard).toHaveBeenCalledWith("alpha");
      expect(respondCalls).toEqual([{ ok: true, payload: { board }, error: undefined }]);
    });

    it("when getBoard() returns null responds with error", async () => {
      mockGetBoard.mockResolvedValueOnce(null);

      await projectsHandlers["projects.board.get"]!(makeOpts({ project: "gone" }));

      expect(respondCalls).toHaveLength(1);
      expect(respondCalls[0]!.ok).toBe(false);
      expect(respondCalls[0]!.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: "project not found: gone",
      });
    });
  });

  describe("projects.queue.get", () => {
    it("with valid params.project calls getQueue() and responds with { queue }", async () => {
      const queue: QueueIndex = {
        available: [],
        claimed: [],
        blocked: [],
        done: [],
        indexedAt: "2026-01-01T00:00:00Z",
      };
      mockGetQueue.mockResolvedValueOnce(queue);

      await projectsHandlers["projects.queue.get"]!(makeOpts({ project: "alpha" }));

      expect(mockGetQueue).toHaveBeenCalledWith("alpha");
      expect(respondCalls).toEqual([{ ok: true, payload: { queue }, error: undefined }]);
    });

    it("when getQueue() returns null responds with error", async () => {
      mockGetQueue.mockResolvedValueOnce(null);

      await projectsHandlers["projects.queue.get"]!(makeOpts({ project: "gone" }));

      expect(respondCalls).toHaveLength(1);
      expect(respondCalls[0]!.ok).toBe(false);
      expect(respondCalls[0]!.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: "project not found: gone",
      });
    });
  });
});
