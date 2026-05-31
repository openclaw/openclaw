import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  addProjectResource,
  addUploadedProjectResource,
  archiveProject,
  buildProjectContextPreview,
  createProject,
  listProjects,
  loadProjectsStore,
  restoreProject,
  updateProject,
} from "./store.js";

let tempDir: string | null = null;

async function testEnv() {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-projects-test-"));
  return { OPENCLAW_STATE_DIR: tempDir } as NodeJS.ProcessEnv;
}

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("projects store", () => {
  it("persists project instructions and note resources", async () => {
    const env = await testEnv();
    const project = await createProject({
      name: "Research Desk",
      instructions: "Prefer primary sources and cite dates.",
      env,
    });

    const resource = await addProjectResource({
      projectId: project.id,
      name: "Brief",
      content: "Key finding: keep project context bounded and readable.",
      env,
    });

    expect(resource.status).toBe("ready");
    expect(resource.textPreview).toContain("Key finding");

    const loaded = await loadProjectsStore(env);
    expect(loaded.projects).toHaveLength(1);
    expect(loaded.projects[0].resources[0].name).toBe("Brief");

    const preview = buildProjectContextPreview(loaded.projects[0], { query: "bounded" });
    expect(preview.blocks.map((block) => block.title)).toEqual(["Project instructions", "Brief"]);
    expect(preview.totalTokenEstimate).toBeGreaterThan(0);
  });

  it("extracts text from local DOCX resources", async () => {
    const env = await testEnv();
    const dir = tempDir ?? os.tmpdir();
    const filePath = path.join(dir, "plan.docx");
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      "<w:document><w:body><w:p><w:r><w:t>DOCX project plan</w:t></w:r></w:p></w:body></w:document>",
    );
    await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));

    const project = await createProject({ name: "Docs", env });
    const resource = await addProjectResource({ projectId: project.id, path: filePath, env });

    expect(resource.status).toBe("ready");
    expect(resource.textPreview).toContain("DOCX project plan");
  });

  it("extracts uploaded Markdown resources without a gateway-local path", async () => {
    const env = await testEnv();
    const project = await createProject({ name: "Uploads", env });

    const resource = await addUploadedProjectResource({
      projectId: project.id,
      fileName: "brief.md",
      mediaType: "text/markdown",
      contentBase64: Buffer.from("# Upload Brief\n\nUse this resource.").toString("base64"),
      env,
    });

    expect(resource.status).toBe("ready");
    expect(resource.sourceType).toBe("uploaded_file");
    expect(resource.sourcePath).toBeUndefined();
    expect(resource.textPreview).toContain("Upload Brief");

    const preview = buildProjectContextPreview(
      await loadProjectsStore(env).then((s) => s.projects[0]),
    );
    expect(preview.blocks.map((block) => block.title)).toContain("brief.md");
  });

  it("lists active projects newest first", async () => {
    const env = await testEnv();
    await createProject({ name: "Older", env });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await createProject({ name: "Newer", env });

    const projects = await listProjects({ env });

    expect(projects.map((project) => project.name)).toEqual(["Newer", "Older"]);
  });

  it("keeps projects active through generic updates and hides them only through archive", async () => {
    const env = await testEnv();
    const project = await createProject({ name: "Mac Studio Project", env });

    await updateProject({
      projectId: project.id,
      description: "Still active",
      archived: true,
      env,
    } as unknown as Parameters<typeof updateProject>[0]);

    expect((await listProjects({ env })).map((entry) => entry.id)).toContain(project.id);

    await archiveProject({ projectId: project.id, env });

    expect((await listProjects({ env })).map((entry) => entry.id)).not.toContain(project.id);
    expect((await listProjects({ env, includeArchived: true })).map((entry) => entry.id)).toContain(
      project.id,
    );

    await restoreProject({ projectId: project.id, env });

    expect((await listProjects({ env })).map((entry) => entry.id)).toContain(project.id);
    expect(
      (await listProjects({ env, includeArchived: true })).find((entry) => entry.id === project.id)
        ?.archived,
    ).toBeUndefined();
  });
});
