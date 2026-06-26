// Tests for project gateway methods.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { projectsHandlers } from "./projects.js";
import type { RespondFn } from "./types.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function captureRespond() {
  const calls: Parameters<RespondFn>[] = [];
  const respond: RespondFn = (...args) => {
    calls.push(args);
  };
  return { calls, respond };
}

async function runProjectHandler(
  method: keyof typeof projectsHandlers,
  params: Record<string, unknown>,
) {
  const { calls, respond } = captureRespond();
  await projectsHandlers[method]({
    req: { type: "req", id: `req-${method}`, method },
    params,
    respond,
    context: { getRuntimeConfig: () => ({}) } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return {
    calls,
    ok: calls[0]?.[0],
    payload: calls[0]?.[1] as Record<string, unknown> | undefined,
    error: calls[0]?.[2] as { message?: string } | undefined,
  };
}

describe("project gateway handlers", () => {
  it("creates, lists, attaches chats, patches context, and archives through RPC", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-project-handlers-" },
      async () => {
        const created = await runProjectHandler("projects.create", {
          name: "OpenClaw Workspaces",
        });
        expect(created.ok).toBe(true);
        const project = created.payload?.project as { projectId: string; name: string };
        expect(project.name).toBe("OpenClaw Workspaces");

        const listed = await runProjectHandler("projects.list", {});
        expect(listed.ok).toBe(true);
        expect((listed.payload?.projects as unknown[]).length).toBe(1);

        const roles = await runProjectHandler("projects.roles.list", {
          projectId: project.projectId,
        });
        expect(roles.ok).toBe(true);
        expect(
          (roles.payload?.roles as Array<{ roleKey: string }>).map((role) => role.roleKey),
        ).toContain("implementation");

        const createdRole = await runProjectHandler("projects.roles.create", {
          projectId: project.projectId,
          name: "Design",
          description: "UX polish",
          instructions: "Focus on daily workflow clarity.",
        });
        expect(createdRole.ok).toBe(true);
        expect(createdRole.payload?.role).toMatchObject({
          roleKey: "design",
          instructions: "Focus on daily workflow clarity.",
        });

        const patchedRole = await runProjectHandler("projects.roles.patch", {
          projectId: project.projectId,
          roleKey: "design",
          description: "UX and interaction polish",
        });
        expect(patchedRole.ok).toBe(true);
        expect(patchedRole.payload?.role).toMatchObject({
          description: "UX and interaction polish",
        });

        const createdDocument = await runProjectHandler("projects.documents.create", {
          projectId: project.projectId,
          title: "Architecture inventory",
          uri: "/vault/Arquitectura Real OpenClaw 2026.6.10.md",
          kind: "obsidian",
          notes: "Technical map",
        });
        expect(createdDocument.ok).toBe(true);
        const document = createdDocument.payload?.document as { documentId: string };
        expect(createdDocument.payload?.document).toMatchObject({
          title: "Architecture inventory",
          includeInContext: true,
          status: "active",
        });

        const listedDocuments = await runProjectHandler("projects.documents.list", {
          projectId: project.projectId,
        });
        expect(listedDocuments.ok).toBe(true);
        expect(listedDocuments.payload?.documents).toMatchObject([
          { documentId: document.documentId },
        ]);

        const patchedDocument = await runProjectHandler("projects.documents.patch", {
          projectId: project.projectId,
          documentId: document.documentId,
          notes: "Updated technical map",
          includeInContext: false,
        });
        expect(patchedDocument.ok).toBe(true);
        expect(patchedDocument.payload?.document).toMatchObject({
          notes: "Updated technical map",
          includeInContext: false,
        });

        const attached = await runProjectHandler("projects.chats.attach", {
          projectId: project.projectId,
          sessionKey: "agent:main:main",
          title: "Planning",
          role: "design",
        });
        expect(attached.ok).toBe(true);
        expect(attached.payload?.chat).toMatchObject({
          projectId: project.projectId,
          sessionKey: "agent:main:main",
          title: "Planning",
          role: "design",
        });

        const resolved = await runProjectHandler("projects.chats.resolve", {
          sessionKey: "agent:main:main",
        });
        expect(resolved.ok).toBe(true);
        expect(resolved.payload?.project).toMatchObject({
          projectId: project.projectId,
          name: "OpenClaw Workspaces",
        });
        expect(resolved.payload?.chat).toMatchObject({
          projectId: project.projectId,
          sessionKey: "agent:main:main",
        });

        const context = await runProjectHandler("projects.context.patch", {
          projectId: project.projectId,
          summary: "Shared context",
          decisions: ["Use SQLite"],
        });
        expect(context.ok).toBe(true);
        expect(context.payload?.context).toMatchObject({
          projectId: project.projectId,
          summary: "Shared context",
          decisions: ["Use SQLite"],
        });

        const archivedChat = await runProjectHandler("projects.chats.archive", {
          projectId: project.projectId,
          sessionKey: "agent:main:main",
        });
        expect(archivedChat.ok).toBe(true);
        expect(archivedChat.payload?.chat).toMatchObject({ status: "archived" });

        const resolvedAfterArchive = await runProjectHandler("projects.chats.resolve", {
          sessionKey: "agent:main:main",
        });
        expect(resolvedAfterArchive.ok).toBe(true);
        expect(resolvedAfterArchive.payload).toEqual({ project: undefined, chat: undefined });

        const restoredChat = await runProjectHandler("projects.chats.restore", {
          projectId: project.projectId,
          sessionKey: "agent:main:main",
        });
        expect(restoredChat.ok).toBe(true);
        expect(restoredChat.payload?.chat).toMatchObject({ status: "active" });

        const detachedChat = await runProjectHandler("projects.chats.detach", {
          projectId: project.projectId,
          sessionKey: "agent:main:main",
        });
        expect(detachedChat.ok).toBe(true);
        expect(detachedChat.payload).toEqual({});

        const archivedProject = await runProjectHandler("projects.archive", {
          projectId: project.projectId,
        });
        expect(archivedProject.ok).toBe(true);
        expect(archivedProject.payload?.project).toMatchObject({ status: "archived" });

        const restoredProject = await runProjectHandler("projects.restore", {
          projectId: project.projectId,
        });
        expect(restoredProject.ok).toBe(true);
        expect(restoredProject.payload?.project).toMatchObject({ status: "active" });

        const archivedRole = await runProjectHandler("projects.roles.archive", {
          projectId: project.projectId,
          roleKey: "design",
        });
        expect(archivedRole.ok).toBe(true);
        expect(archivedRole.payload?.role).toMatchObject({ status: "archived" });

        const restoredRole = await runProjectHandler("projects.roles.restore", {
          projectId: project.projectId,
          roleKey: "design",
        });
        expect(restoredRole.ok).toBe(true);
        expect(restoredRole.payload?.role).toMatchObject({ status: "active" });

        const archivedDocument = await runProjectHandler("projects.documents.archive", {
          projectId: project.projectId,
          documentId: document.documentId,
        });
        expect(archivedDocument.ok).toBe(true);
        expect(archivedDocument.payload?.document).toMatchObject({ status: "archived" });

        const restoredDocument = await runProjectHandler("projects.documents.restore", {
          projectId: project.projectId,
          documentId: document.documentId,
        });
        expect(restoredDocument.ok).toBe(true);
        expect(restoredDocument.payload?.document).toMatchObject({ status: "active" });
      },
    );
  });

  it("rejects invalid params and missing projects", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-project-handlers-invalid-" },
      async () => {
        const invalid = await runProjectHandler("projects.create", { name: "" });
        expect(invalid.ok).toBe(false);
        expect(invalid.error?.message).toContain("invalid projects.create params");

        const missing = await runProjectHandler("projects.chats.list", {
          projectId: "proj_missing",
        });
        expect(missing.ok).toBe(false);
        expect(missing.error?.message).toContain("project not found");
      },
    );
  });

  it("imports project documents from pasted references and scanned folders", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-doc-import-"));
    await fs.mkdir(path.join(root, "Nested"), { recursive: true });
    await fs.writeFile(path.join(root, "Nested", "Decision Log.md"), "# Decisions\n", "utf8");
    await fs.writeFile(path.join(root, "ignore.png"), "", "utf8");

    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-project-doc-import-state-" },
      async () => {
        const created = await runProjectHandler("projects.create", {
          name: "Import workspace",
        });
        const project = created.payload?.project as { projectId: string };

        const imported = await runProjectHandler("projects.documents.import", {
          projectId: project.projectId,
          text: [
            "Architecture | /vault/Architecture.md | obsidian | Start here",
            "[Runbook](https://example.test/runbook)",
            "[[Roadmap|Product Roadmap]]",
          ].join("\n"),
          roots: [root],
          recursive: true,
          includeInContext: true,
        });

        expect(imported.ok).toBe(true);
        expect(imported.payload).toMatchObject({
          importedCount: 4,
          skippedCount: 0,
          scannedCount: 4,
        });
        expect(imported.payload?.documents).toMatchObject([
          { title: "Architecture", uri: "/vault/Architecture.md", kind: "obsidian" },
          { title: "Runbook", uri: "https://example.test/runbook", kind: "url" },
          { title: "Product Roadmap", uri: "Roadmap", kind: "obsidian" },
          { title: "Decision Log", kind: "md" },
        ]);

        const duplicate = await runProjectHandler("projects.documents.import", {
          projectId: project.projectId,
          text: "Architecture | /vault/Architecture.md",
        });
        expect(duplicate.ok).toBe(true);
        expect(duplicate.payload).toMatchObject({
          importedCount: 0,
          skippedCount: 1,
          scannedCount: 1,
        });
      },
    );
  });
});
