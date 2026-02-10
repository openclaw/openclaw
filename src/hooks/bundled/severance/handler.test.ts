import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SOUL_FILENAME, type WorkspaceBootstrapFile } from "../../../agents/workspace.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { DEFAULT_SOUL_INNIE, DEFAULT_SOUL_OUTIE } from "../../severance.js";
import severanceHook from "./handler.js";

function makeBootstrapEvent(params: {
  workspaceDir: string;
  files: WorkspaceBootstrapFile[];
  hookConfig?: Record<string, unknown>;
  sessionKey?: string;
}) {
  const sessionKey = params.sessionKey ?? "main";
  return {
    type: "agent" as const,
    action: "bootstrap",
    sessionKey,
    timestamp: new Date(),
    messages: [] as string[],
    context: {
      sessionKey,
      workspaceDir: params.workspaceDir,
      bootstrapFiles: params.files,
      cfg: {
        hooks: {
          internal: {
            entries: {
              severance: {
                enabled: true,
                ...(params.hookConfig ?? {
                  activation: { mode: "manual", persona: "innie" },
                }),
              },
            },
          },
        },
        agents: { defaults: { userTimezone: "UTC" } },
      },
    },
  };
}

describe("severance handler", () => {
  it("skips non-bootstrap events", async () => {
    const event = {
      type: "command" as const,
      action: "new",
      sessionKey: "main",
      timestamp: new Date(),
      messages: [],
      context: {},
    };
    await severanceHook(event);
    // No error thrown, no changes
  });

  it("skips subagent sessions", async () => {
    const tempDir = await makeTempWorkspace("openclaw-sev-handler-");
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_SOUL_INNIE, content: "work soul" });

    const files: WorkspaceBootstrapFile[] = [
      {
        name: DEFAULT_SOUL_FILENAME,
        path: path.join(tempDir, DEFAULT_SOUL_FILENAME),
        content: "original",
        missing: false,
      },
    ];
    const event = makeBootstrapEvent({
      workspaceDir: tempDir,
      files,
      sessionKey: "subagent:task-abc",
    });
    await severanceHook(event);

    const soul = event.context.bootstrapFiles.find(
      (f: WorkspaceBootstrapFile) => f.name === DEFAULT_SOUL_FILENAME,
    );
    expect(soul?.content).toBe("original");
  });

  it("skips when disabled", async () => {
    const tempDir = await makeTempWorkspace("openclaw-sev-handler-");
    const files: WorkspaceBootstrapFile[] = [
      {
        name: DEFAULT_SOUL_FILENAME,
        path: path.join(tempDir, DEFAULT_SOUL_FILENAME),
        content: "original",
        missing: false,
      },
    ];
    const event = makeBootstrapEvent({
      workspaceDir: tempDir,
      files,
      hookConfig: { enabled: false },
    });
    // Override the cfg to set enabled: false
    (event.context.cfg as Record<string, unknown>).hooks = {
      internal: { entries: { severance: { enabled: false } } },
    };
    await severanceHook(event);

    const soul = event.context.bootstrapFiles.find(
      (f: WorkspaceBootstrapFile) => f.name === DEFAULT_SOUL_FILENAME,
    );
    expect(soul?.content).toBe("original");
  });

  it("swaps to innie persona", async () => {
    const tempDir = await makeTempWorkspace("openclaw-sev-handler-");
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_SOUL_INNIE, content: "innie soul" });

    const files: WorkspaceBootstrapFile[] = [
      {
        name: DEFAULT_SOUL_FILENAME,
        path: path.join(tempDir, DEFAULT_SOUL_FILENAME),
        content: "original",
        missing: false,
      },
    ];
    const event = makeBootstrapEvent({
      workspaceDir: tempDir,
      files,
      hookConfig: { activation: { mode: "manual", persona: "innie" } },
    });
    await severanceHook(event);

    const soul = event.context.bootstrapFiles.find(
      (f: WorkspaceBootstrapFile) => f.name === DEFAULT_SOUL_FILENAME,
    );
    expect(soul?.content).toBe("innie soul");
  });

  it("swaps to outie persona", async () => {
    const tempDir = await makeTempWorkspace("openclaw-sev-handler-");
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_SOUL_OUTIE, content: "outie soul" });

    const files: WorkspaceBootstrapFile[] = [
      {
        name: DEFAULT_SOUL_FILENAME,
        path: path.join(tempDir, DEFAULT_SOUL_FILENAME),
        content: "original",
        missing: false,
      },
    ];
    const event = makeBootstrapEvent({
      workspaceDir: tempDir,
      files,
      hookConfig: { activation: { mode: "manual", persona: "outie" } },
    });
    await severanceHook(event);

    const soul = event.context.bootstrapFiles.find(
      (f: WorkspaceBootstrapFile) => f.name === DEFAULT_SOUL_FILENAME,
    );
    expect(soul?.content).toBe("outie soul");
  });
});
