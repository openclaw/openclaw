import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareReplyWorkspace } from "../auto-reply/reply/reply-workspace.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { publishAgentInstructions } from "./workspace-bootstrap-publish.js";

const templates = vi.hoisted(() => ({ dir: "" }));
vi.mock("./workspace-templates.js", () => ({
  resolveWorkspaceTemplateSearchDirs: async () => [templates.dir],
}));

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "workspace-templates-" });
  templates.dir = state.path("templates");
  await fs.mkdir(templates.dir);
});
afterEach(async () => {
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
  for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
    await fs.writeFile(path.join(state.workspaceDir, name), `User-authored ${name}\n`);
  }
  await fs.mkdir(path.join(templates.dir, "SOUL.md"));
  await expect(prepare()).rejects.toHaveProperty("code", "EISDIR");
});

it("preserves exact custom-purpose matching for existing instructions", async () => {
  const agentsPath = path.join(state.workspaceDir, "AGENTS.md");
  const template = async () => "# Instructions";
  const content = "# Agent purpose\n\nApproved purpose\n\n# Instructions";
  await fs.writeFile(agentsPath, content);

  await expect(
    publishAgentInstructions(agentsPath, template, "Approved purpose"),
  ).resolves.toBeUndefined();
  await expect(publishAgentInstructions(agentsPath, template, "Different purpose")).rejects.toThrow(
    "Existing AGENTS.md was preserved",
  );
  await expect(fs.readFile(agentsPath, "utf8")).resolves.toBe(content);
});

it("initializes missing files when packaged templates are readable", async () => {
  const names = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md"];
  for (const name of names) {
    await fs.writeFile(path.join(templates.dir, name), `# Template for ${name}\n`);
  }
  await expect(prepare()).resolves.toMatchObject({
    bootstrapPending: true,
    identityPathCreated: true,
  });
  for (const name of names) {
    await expect(fs.readFile(path.join(state.workspaceDir, name), "utf8")).resolves.toBe(
      `# Template for ${name}\n`,
    );
  }
});
