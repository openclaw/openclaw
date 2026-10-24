import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareReplyWorkspace } from "../auto-reply/reply/reply-workspace.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { fileDiffersFromTemplate } from "./workspace.js";

const templates = vi.hoisted(() => ({ dir: "" }));
vi.mock("./workspace-templates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-templates.js")>()),
  resolveWorkspaceTemplateSearchDirs: async () => [templates.dir],
}));

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "workspace-templates-" });
  templates.dir = state.path("templates");
  await fs.mkdir(templates.dir);
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});

function prepare() {
  return prepareReplyWorkspace({
    dir: state.workspaceDir,
    ensureBootstrapFiles: true,
    useFastTestBootstrap: false,
    provisioningInput: { cfg: {}, agentId: "main", workspaceDir: state.workspaceDir },
  });
}

it("prepares a provisioned reply workspace without packaged templates or changing user files", async () => {
  const files = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
  for (const name of files) {
    await fs.writeFile(path.join(state.workspaceDir, name), `User-authored ${name}\n`);
  }

  await expect(prepare()).resolves.toMatchObject({
    dir: state.workspaceDir,
    bootstrapPending: false,
    identityPathCreated: false,
  });

  for (const name of files) {
    await expect(fs.readFile(path.join(state.workspaceDir, name), "utf8")).resolves.toBe(
      `User-authored ${name}\n`,
    );
  }
  await expect(fs.stat(path.join(state.workspaceDir, "BOOTSTRAP.md"))).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
});

it("still requires a template to provision a missing workspace file", async () => {
  await expect(prepare()).rejects.toThrow("Missing workspace template: AGENTS.md");
  await expect(fs.stat(path.join(state.workspaceDir, "AGENTS.md"))).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
});

it("propagates template read errors other than absence during comparison", async () => {
  await fs.writeFile(path.join(state.workspaceDir, "SOUL.md"), "User-authored soul\n");
  await fs.mkdir(path.join(templates.dir, "SOUL.md"));

  await expect(fileDiffersFromTemplate(state.workspaceDir, "SOUL.md")).rejects.toHaveProperty(
    "code",
    "EISDIR",
  );
});
