import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import type { SandboxWorkspaceInfo } from "../../agents/sandbox/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveTaskSuggestionHostCwd } from "./task-suggestion-host-cwd.js";

const sandboxState = vi.hoisted(() => ({
  info: null as SandboxWorkspaceInfo | null,
}));

const sessionState = vi.hoisted(() => ({ entry: undefined as unknown }));

vi.mock("../../agents/sandbox/context.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    ensureSandboxWorkspaceForSession: vi.fn(async () => sandboxState.info),
  };
});

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    loadGatewaySessionEntryReadOnly: vi.fn(() => {
      if (sessionState.entry === undefined) {
        throw new Error("no session store in unit test");
      }
      return { entry: sessionState.entry };
    }),
  };
});

const tempRoots: string[] = [];

afterEach(() => {
  sandboxState.info = null;
  sessionState.entry = undefined;
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "task-suggestion-cwd-")));
  tempRoots.push(root);
  return root;
}

function testConfig(params: { workspace: string; backend?: string }): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend: params.backend ?? "docker",
          scope: "agent",
          workspaceAccess: "rw",
        },
      },
      entries: { main: { workspace: params.workspace } },
    },
  } as unknown as OpenClawConfig;
}

function useSandbox(info: {
  workspaceDir: string;
  containerWorkdir?: string;
  dockerBinds?: string[];
}) {
  sandboxState.info = {
    workspaceDir: info.workspaceDir,
    agentWorkspaceDir: info.workspaceDir,
    workspaceAccess: "rw",
    ...(info.containerWorkdir ? { containerWorkdir: info.containerWorkdir } : {}),
    ...(info.dockerBinds ? { dockerBinds: info.dockerBinds } : {}),
  };
}

describe("task suggestion host cwd lifecycle", () => {
  it.runIf(process.platform !== "win32")(
    "acceptance keeps an already-resolved host directory under overlapping container prefixes",
    async () => {
      // Host /tmp/<root>/project mounted at container /tmp/<root>: the recorded
      // host path textually sits under a container prefix, so translating it
      // again would select <hostDir>/project (or fail). Native Windows paths
      // are never posix-absolute, so this overlap only exists on POSIX hosts.
      const root = makeTempRoot();
      const hostDir = path.join(root, "project");
      fs.mkdirSync(path.join(hostDir, "project"), { recursive: true });
      const containerWorkdir = path.posix.dirname(hostDir);
      useSandbox({ workspaceDir: hostDir, containerWorkdir });
      const cfg = testConfig({ workspace: root });

      const created = await resolveTaskSuggestionHostCwd({
        cfg,
        sessionKey: "overlap-source",
        agentId: "main",
        cwd: containerWorkdir,
      });
      expect(created).toEqual({ ok: true, cwd: hostDir });

      const accepted = await resolveTaskSuggestionHostCwd({
        cfg,
        sessionKey: "overlap-source",
        agentId: "main",
        cwd: hostDir,
        cwdAlreadyHostResolved: true,
      });
      expect(accepted).toEqual({ ok: true, cwd: hostDir });
    },
  );

  it("creation still translates container paths for local-container backends", async () => {
    const root = makeTempRoot();
    const nested = path.join(root, "nested", "project");
    fs.mkdirSync(nested, { recursive: true });
    useSandbox({ workspaceDir: root, containerWorkdir: "/workspace" });
    const cfg = testConfig({ workspace: root });

    const result = await resolveTaskSuggestionHostCwd({
      cfg,
      sessionKey: "docker-source",
      agentId: "main",
      cwd: "/workspace/nested/project",
    });
    expect(result).toEqual({ ok: true, cwd: nested });
  });

  it("does not invent a local host path for remote ssh workspaces", async () => {
    const root = makeTempRoot();
    // The stale local copy the old container-first mapping would have selected.
    fs.mkdirSync(path.join(root, "project"), { recursive: true });
    useSandbox({ workspaceDir: root, containerWorkdir: "/remote/work" });
    const cfg = testConfig({ workspace: root, backend: "ssh" });

    const result = await resolveTaskSuggestionHostCwd({
      cfg,
      sessionKey: "ssh-source",
      agentId: "main",
      cwd: "/remote/work/project",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("task suggestion cwd is unavailable");
    }
  });

  it("skips mount translation for backends without a local mount contract", async () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, "project"), { recursive: true });
    useSandbox({ workspaceDir: root, containerWorkdir: "/remote/work" });
    const cfg = testConfig({ workspace: root, backend: "future-backend" });

    const result = await resolveTaskSuggestionHostCwd({
      cfg,
      sessionKey: "custom-source",
      agentId: "main",
      cwd: "/remote/work/project",
    });
    expect(result.ok).toBe(false);
  });

  it("acceptance rejects a missing host-resolved cwd instead of re-translating it", async () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, "real"), { recursive: true });
    useSandbox({ workspaceDir: root, containerWorkdir: "/workspace" });
    const cfg = testConfig({ workspace: root });

    // /workspace/real still maps onto an existing host directory, but the
    // acceptance flag marks the recorded cwd as already host-resolved, so a
    // missing target must stay terminal instead of selecting another folder.
    const missing = await resolveTaskSuggestionHostCwd({
      cfg,
      sessionKey: "accept-missing",
      agentId: "main",
      cwd: "/workspace/real",
      cwdAlreadyHostResolved: true,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.message).toContain("task suggestion cwd is unavailable");
    }

    const present = await resolveTaskSuggestionHostCwd({
      cfg,
      sessionKey: "accept-present",
      agentId: "main",
      cwd: path.join(root, "real"),
      cwdAlreadyHostResolved: true,
    });
    expect(present).toEqual({ ok: true, cwd: path.join(root, "real") });
  });

  it("carries the source session skill snapshot into sandbox workspace resolution", async () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, "project"), { recursive: true });
    useSandbox({ workspaceDir: root, containerWorkdir: "/workspace" });
    const cfg = testConfig({ workspace: root });
    sessionState.entry = {
      skillsSnapshot: {
        prompt: "",
        skills: [],
        librarySelections: [
          {
            skillId: "12345678-1234-1234-1234-1234567890ab",
            revision: "a".repeat(64),
            name: "test-skill",
            ownerProfileId: null,
          },
        ],
      },
    };
    vi.mocked(ensureSandboxWorkspaceForSession).mockClear();

    const result = await resolveTaskSuggestionHostCwd({
      cfg,
      sessionKey: "skill-source",
      agentId: "main",
      cwd: "/workspace/project",
    });
    expect(result).toEqual({ ok: true, cwd: path.join(root, "project") });
    expect(vi.mocked(ensureSandboxWorkspaceForSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        skillsSnapshot: expect.objectContaining({
          librarySelections: expect.arrayContaining([
            expect.objectContaining({ name: "test-skill" }),
          ]),
        }),
      }),
    );
  });
});
