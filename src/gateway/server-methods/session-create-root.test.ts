import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSessionCreateFilesystemRoot } from "./session-create-root.js";

const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let cfg: OpenClawConfig;
let workspace: string;

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-session-root-", layout: "split" });
  workspace = state.workspaceDir;
  await fs.mkdir(path.join(workspace, "project"));
  await fs.mkdir(state.path("outside"), { recursive: true });
  await fs.symlink(workspace, state.path("workspace-alias"), directoryLinkType);
  await fs.symlink(state.path("outside"), path.join(workspace, "escape"), directoryLinkType);
  cfg = {
    agents: {
      defaults: { sandbox: { mode: "all" } },
      entries: { main: { workspace }, other: { workspace: state.path("outside") } },
    },
  };
});

afterEach(() => state?.cleanup());

function prepare(options: Partial<Parameters<typeof prepareSessionCreateFilesystemRoot>[0]> = {}) {
  return prepareSessionCreateFilesystemRoot({
    cfg,
    targetAgentId: "main",
    enforceSandboxContainment: true,
    ...options,
  });
}

it("admits a configured workspace alias and returns the canonical root", () => {
  cfg.agents!.entries!.main!.workspace = state.path("workspace-alias");
  const project = path.join(workspace, "project");
  expect(prepare({ sessionCwd: project })).toEqual({
    ok: true,
    value: { sessionRoot: project, sessionCwd: project },
  });
});

it("rejects a leaf symlink escape against only the selected agent", () => {
  expect(prepare({ sessionCwd: path.join(workspace, "escape") })).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "sessions.create cwd is outside the sandboxed agent workspace",
    },
  });
});

it("fails closed for a missing workspace without creating the missing path", async () => {
  cfg.agents!.entries!.main!.workspace = state.path("missing-workspace");
  expect(prepare({ sessionCwd: path.join(workspace, "project") })).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: expect.stringContaining("cwd is unavailable:") },
  });
  await expect(fs.stat(path.join(workspace, "missing"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(fs.stat(state.path("missing-workspace"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("creates an omitted workspace through its alias and leaves cwd unset", async () => {
  const missing = state.path("workspace-alias", "new-workspace");
  cfg.agents!.entries!.main!.workspace = missing;
  expect(prepare()).toEqual({
    ok: true,
    value: { sessionRoot: path.join(workspace, "new-workspace"), sessionCwd: undefined },
  });
  expect((await fs.stat(missing)).isDirectory()).toBe(true);
});

it("does not resolve remote node paths on the Gateway", () => {
  const sessionCwd = "C:\\remote\\missing";
  expect(prepare({ requestedExecNode: "remote", sessionCwd })).toEqual({
    ok: true,
    value: { sessionCwd },
  });
});
