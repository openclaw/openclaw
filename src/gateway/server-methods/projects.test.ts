import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectsHandlers } from "./projects.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-projects-rpc-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(stateDir, { recursive: true, force: true });
});

async function directProjectReq(
  method: keyof typeof projectsHandlers,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; payload?: unknown; error?: unknown }> {
  let result: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  await projectsHandlers[method]({
    req: {} as never,
    params,
    respond: (ok, payload, error) => {
      result = {
        ok,
        payload,
        error,
      };
    },
    context: {
      getRuntimeConfig: () => ({}),
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  if (!result) {
    throw new Error(`${method} did not respond`);
  }
  return result;
}

describe("projects RPC handlers", () => {
  it("uploads browser file resources and exposes them through context preview", async () => {
    const created = await directProjectReq("projects.create", {
      name: "Launch Room",
      instructions: "Use the uploaded resources.",
    });
    expect(created.ok).toBe(true);
    const projectId = (created.payload as { project: { id: string } } | undefined)?.project.id;
    expect(projectId).toBeTruthy();

    const uploaded = await directProjectReq("projects.resources.upload", {
      projectId,
      fileName: "launch.md",
      mediaType: "text/markdown",
      contentBase64: Buffer.from("Launch risk: copy review is blocked.").toString("base64"),
    });
    const uploadedPayload = uploaded.payload as
      | { resource: { name: string; status: string; text?: string; sourceType?: string } }
      | undefined;

    expect(uploaded.ok).toBe(true);
    expect(uploadedPayload?.resource).toMatchObject({
      name: "launch.md",
      status: "ready",
      sourceType: "uploaded_file",
    });
    expect(uploadedPayload?.resource.text).toBeUndefined();

    const preview = await directProjectReq("projects.context.preview", { projectId });
    const previewPayload = preview.payload as
      | { blocks: Array<{ title: string; text: string }> }
      | undefined;
    expect(preview.ok).toBe(true);
    expect(previewPayload?.blocks.map((block) => block.title)).toContain("launch.md");
    expect(previewPayload?.blocks.map((block) => block.text).join("\n")).toContain("copy review");
  });

  it("rejects archive flags on generic project updates so projects stay visible until explicit archive", async () => {
    const created = await directProjectReq("projects.create", {
      name: "Mac Studio Projects",
      instructions: "Keep active unless archived.",
    });
    expect(created.ok).toBe(true);
    const projectId = (created.payload as { project: { id: string } } | undefined)?.project.id;
    expect(projectId).toBeTruthy();

    const genericUpdate = await directProjectReq("projects.update", {
      projectId,
      description: "Generic updates are safe.",
      archived: true,
    });

    expect(genericUpdate.ok).toBe(false);

    const listAfterRejectedUpdate = await directProjectReq("projects.list", {});
    const activeProjects = (
      listAfterRejectedUpdate.payload as { projects: Array<{ id: string }> } | undefined
    )?.projects;
    expect(activeProjects?.map((project) => project.id)).toContain(projectId);

    const archived = await directProjectReq("projects.delete", { projectId });
    expect(archived.ok).toBe(true);

    const listAfterArchive = await directProjectReq("projects.list", {});
    const visibleProjects = (
      listAfterArchive.payload as { projects: Array<{ id: string }> } | undefined
    )?.projects;
    expect(visibleProjects?.map((project) => project.id)).not.toContain(projectId);

    const archivedList = await directProjectReq("projects.list", { includeArchived: true });
    const allProjects = (archivedList.payload as { projects: Array<{ id: string }> } | undefined)
      ?.projects;
    expect(allProjects?.map((project) => project.id)).toContain(projectId);

    const restored = await directProjectReq("projects.restore", { projectId });
    expect(restored.ok).toBe(true);

    const listAfterRestore = await directProjectReq("projects.list", {});
    const activeAfterRestore = (
      listAfterRestore.payload as
        | { projects: Array<{ id: string; archived?: boolean }> }
        | undefined
    )?.projects;
    expect(
      activeAfterRestore?.find((project) => project.id === projectId)?.archived,
    ).toBeUndefined();
  });
});
