// Tests for SQLite-backed project workspace persistence.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  archiveProject,
  archiveProjectChat,
  archiveProjectDocument,
  archiveProjectRole,
  createProject,
  createProjectDocument,
  createProjectRole,
  detachProjectChat,
  getActiveProjectForSession,
  getProjectDocument,
  getProject,
  getProjectContext,
  listProjectChats,
  listProjectDocuments,
  listProjects,
  listProjectRoles,
  patchProject,
  patchProjectChat,
  patchProjectContext,
  patchProjectDocument,
  patchProjectRole,
  restoreProject,
  restoreProjectChat,
  restoreProjectDocument,
  restoreProjectRole,
  upsertProjectChat,
} from "./project-store.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("project store", () => {
  it("persists projects, project chats, and shared context", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-project-store-" },
      async () => {
        const project = createProject({
          name: "OpenClaw Improvements",
          description: "Core project workspace MVP",
          color: "blue",
          icon: "folder",
          sortOrder: 3,
          metadata: { source: "test" },
        });

        expect(project.projectId).toMatch(/^proj_/u);
        expect(project.status).toBe("active");
        expect(listProjects().map((entry) => entry.projectId)).toEqual([project.projectId]);
        expect(
          listProjectRoles({ projectId: project.projectId }).map((role) => role.roleKey),
        ).toEqual(["implementation", "research", "review", "planning"]);

        const patched = patchProject(project.projectId, {
          name: "OpenClaw Workspaces",
          description: null,
          sortOrder: 1,
          defaultRoleKey: "implementation",
        });
        expect(patched?.name).toBe("OpenClaw Workspaces");
        expect(patched?.description).toBeUndefined();
        expect(patched?.sortOrder).toBe(1);
        expect(patched?.defaultRoleKey).toBe("implementation");

        const designer = createProjectRole({
          projectId: project.projectId,
          name: "UX Design",
          description: "Design user flows.",
          instructions: "Prioriza claridad visual y acciones frecuentes.",
          sortOrder: 10,
        });
        expect(designer).toMatchObject({
          projectId: project.projectId,
          roleKey: "ux-design",
          status: "active",
        });
        expect(
          patchProjectRole({
            projectId: project.projectId,
            roleKey: "ux-design",
            patch: { description: "Design the daily workflow." },
          })?.description,
        ).toBe("Design the daily workflow.");
        expect(
          archiveProjectRole({ projectId: project.projectId, roleKey: "ux-design" })?.status,
        ).toBe("archived");
        expect(
          restoreProjectRole({ projectId: project.projectId, roleKey: "ux-design" })?.status,
        ).toBe("active");
        expect(
          patchProject(project.projectId, { defaultRoleKey: "ux-design" })?.defaultRoleKey,
        ).toBe("ux-design");
        archiveProjectRole({ projectId: project.projectId, roleKey: "ux-design" });
        expect(getProject(project.projectId)?.defaultRoleKey).toBeUndefined();
        restoreProjectRole({ projectId: project.projectId, roleKey: "ux-design" });

        const chat = upsertProjectChat({
          projectId: project.projectId,
          sessionKey: "agent:main:main",
          agentId: "main",
          title: "Architecture",
          role: "ux-design",
        });
        expect(chat).toMatchObject({
          projectId: project.projectId,
          sessionKey: "agent:main:main",
          status: "active",
          title: "Architecture",
        });
        expect(getActiveProjectForSession("agent:main:main")?.role).toMatchObject({
          roleKey: "ux-design",
          instructions: "Prioriza claridad visual y acciones frecuentes.",
        });
        expect(listProjectChats({ projectId: project.projectId })).toHaveLength(1);

        const patchedChat = patchProjectChat({
          projectId: project.projectId,
          sessionKey: "agent:main:main",
          patch: { title: "Backend Architecture", role: null },
        });
        expect(patchedChat?.title).toBe("Backend Architecture");
        expect(patchedChat?.role).toBeUndefined();

        const context = patchProjectContext(project.projectId, {
          summary: "Implement project workspaces.",
          instructions: "Keep transcripts intact.",
          decisions: ["Store project metadata in SQLite"],
          documents: ["Arquitectura Real OpenClaw 2026.6.10.md"],
        });
        expect(context).toMatchObject({
          projectId: project.projectId,
          summary: "Implement project workspaces.",
          decisions: ["Store project metadata in SQLite"],
        });
        expect(getProject(project.projectId)?.context?.documents).toEqual([
          "Arquitectura Real OpenClaw 2026.6.10.md",
        ]);

        const document = createProjectDocument({
          projectId: project.projectId,
          title: "Architecture inventory",
          uri: "/home/matlop/Documentos/Obsidian/10-Proyectos/MejorasOpenClaw/Arquitectura Real OpenClaw 2026.6.10.md",
          kind: "obsidian",
          notes: "Primary technical map for project workspaces.",
        });
        expect(document).toMatchObject({
          projectId: project.projectId,
          title: "Architecture inventory",
          includeInContext: true,
          status: "active",
        });
        expect(document?.documentId).toMatch(/^doc_/u);
        expect(listProjectDocuments({ projectId: project.projectId })).toHaveLength(1);
        expect(
          getActiveProjectForSession("agent:main:main")?.documents?.map((entry) => entry.title),
        ).toEqual(["Architecture inventory"]);

        const patchedDocument = patchProjectDocument({
          projectId: project.projectId,
          documentId: document?.documentId ?? "",
          patch: { notes: "Updated notes.", includeInContext: false },
        });
        expect(patchedDocument?.notes).toBe("Updated notes.");
        expect(patchedDocument?.includeInContext).toBe(false);
        expect(getActiveProjectForSession("agent:main:main")?.documents).toBeUndefined();

        patchProjectDocument({
          projectId: project.projectId,
          documentId: document?.documentId ?? "",
          patch: { includeInContext: true },
        });
        expect(
          archiveProjectDocument({
            projectId: project.projectId,
            documentId: document?.documentId ?? "",
          })?.status,
        ).toBe("archived");
        expect(listProjectDocuments({ projectId: project.projectId })).toEqual([]);
        expect(
          restoreProjectDocument({
            projectId: project.projectId,
            documentId: document?.documentId ?? "",
          })?.status,
        ).toBe("active");
        expect(
          getProjectDocument({
            projectId: project.projectId,
            documentId: document?.documentId ?? "",
          }),
        ).toMatchObject({ title: "Architecture inventory" });

        const archivedChat = archiveProjectChat({
          projectId: project.projectId,
          sessionKey: "agent:main:main",
        });
        expect(archivedChat?.status).toBe("archived");
        expect(listProjectChats({ projectId: project.projectId })).toEqual([]);
        expect(
          listProjectChats({ projectId: project.projectId, includeArchived: true }),
        ).toHaveLength(1);

        const restoredChat = restoreProjectChat({
          projectId: project.projectId,
          sessionKey: "agent:main:main",
        });
        expect(restoredChat?.status).toBe("active");
        expect(listProjectChats({ projectId: project.projectId })).toHaveLength(1);

        const archivedProject = archiveProject(project.projectId);
        expect(archivedProject?.status).toBe("archived");
        expect(listProjects()).toEqual([]);
        expect(listProjects({ includeArchived: true })).toHaveLength(1);
        expect(listProjectChats({ projectId: project.projectId })).toEqual([]);

        const restoredProject = restoreProject(project.projectId);
        expect(restoredProject?.status).toBe("active");
        expect(listProjects()).toHaveLength(1);
        expect(
          listProjectChats({ projectId: project.projectId, includeArchived: true }),
        ).toHaveLength(1);

        expect(
          detachProjectChat({ projectId: project.projectId, sessionKey: "agent:main:main" }),
        ).toBe(true);
        expect(listProjectChats({ projectId: project.projectId, includeArchived: true })).toEqual(
          [],
        );
        expect(getProjectContext(project.projectId)?.summary).toBe("Implement project workspaces.");
      },
    );
  });
});
