import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const requireValidConfigMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const logConfigUpdatedMock = vi.hoisted(() => vi.fn());
const moveToTrashMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const resolveSessionTranscriptsDirForAgentMock = vi.hoisted(() =>
  vi.fn((agentId?: string) => `sessions/${agentId ?? "main"}`),
);

vi.mock("./agents.command-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agents.command-shared.js")>()),
  requireValidConfig: requireValidConfigMock,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("../config/logging.js", () => ({
  logConfigUpdated: logConfigUpdatedMock,
}));

vi.mock("../config/sessions.js", () => ({
  resolveSessionTranscriptsDirForAgent: resolveSessionTranscriptsDirForAgentMock,
}));

vi.mock("./onboard-helpers.js", () => ({
  moveToTrash: moveToTrashMock,
}));

import { agentsDeleteCommand } from "./agents.js";

const runtime = createTestRuntime();

describe("agents delete command", () => {
  beforeEach(() => {
    requireValidConfigMock.mockReset();
    writeConfigFileMock.mockClear();
    logConfigUpdatedMock.mockClear();
    moveToTrashMock.mockClear();
    resolveSessionTranscriptsDirForAgentMock.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("skips workspace cleanup when another configured agent still uses it", async () => {
    const sharedWorkspace = path.resolve("tmp", "workspace-shared-configured");
    const mainAgentDir = path.resolve("tmp", "agent-main");
    const opsAgentDir = path.resolve("tmp", "agent-ops");

    requireValidConfigMock.mockResolvedValue({
      agents: {
        defaults: { workspace: sharedWorkspace },
        list: [
          { id: "main", workspace: sharedWorkspace, agentDir: mainAgentDir },
          { id: "ops", workspace: sharedWorkspace, agentDir: opsAgentDir },
        ],
      },
    });

    await agentsDeleteCommand({ id: "ops", force: true }, runtime);

    const trashed = moveToTrashMock.mock.calls.map((call) => call[0]);
    expect(trashed).not.toContain(sharedWorkspace);
    expect(trashed).toContain(opsAgentDir);
    expect(trashed).toContain("sessions/ops");
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Skipped workspace cleanup"));
  });

  it("removes workspace when no remaining agent uses it", async () => {
    const mainWorkspace = path.resolve("tmp", "workspace-main");
    const opsWorkspace = path.resolve("tmp", "workspace-ops");
    const opsAgentDir = path.resolve("tmp", "agent-ops-unique");

    requireValidConfigMock.mockResolvedValue({
      agents: {
        defaults: { workspace: mainWorkspace },
        list: [
          { id: "main", workspace: mainWorkspace, agentDir: path.resolve("tmp", "agent-main") },
          { id: "ops", workspace: opsWorkspace, agentDir: opsAgentDir },
        ],
      },
    });

    await agentsDeleteCommand({ id: "ops", force: true }, runtime);

    const trashed = moveToTrashMock.mock.calls.map((call) => call[0]);
    expect(trashed).toContain(opsWorkspace);
    expect(trashed).toContain(opsAgentDir);
    expect(trashed).toContain("sessions/ops");
  });

  it("skips workspace cleanup when deletion falls back to implicit main on same workspace", async () => {
    const sharedWorkspace = path.resolve("tmp", "workspace-shared-implicit-main");
    const opsAgentDir = path.resolve("tmp", "agent-ops-implicit");

    requireValidConfigMock.mockResolvedValue({
      agents: {
        defaults: { workspace: sharedWorkspace },
        list: [{ id: "ops", workspace: sharedWorkspace, agentDir: opsAgentDir }],
      },
    });

    await agentsDeleteCommand({ id: "ops", force: true }, runtime);

    const trashed = moveToTrashMock.mock.calls.map((call) => call[0]);
    expect(trashed).not.toContain(sharedWorkspace);
    expect(trashed).toContain(opsAgentDir);
    expect(trashed).toContain("sessions/ops");
  });

  it("reports workspaceRemoved=false in json mode when workspace cleanup is skipped", async () => {
    const sharedWorkspace = path.resolve("tmp", "workspace-shared-json");
    const mainAgentDir = path.resolve("tmp", "agent-main-json");
    const opsAgentDir = path.resolve("tmp", "agent-ops-json");

    requireValidConfigMock.mockResolvedValue({
      agents: {
        defaults: { workspace: sharedWorkspace },
        list: [
          { id: "main", workspace: sharedWorkspace, agentDir: mainAgentDir },
          { id: "ops", workspace: sharedWorkspace, agentDir: opsAgentDir },
        ],
      },
    });

    await agentsDeleteCommand({ id: "ops", force: true, json: true }, runtime);

    const trashed = moveToTrashMock.mock.calls.map((call) => call[0]);
    expect(trashed).not.toContain(sharedWorkspace);
    expect(trashed).toContain(opsAgentDir);
    expect(trashed).toContain("sessions/ops");

    const jsonLog = runtime.log.mock.calls.at(-1)?.[0];
    expect(typeof jsonLog).toBe("string");
    const payload = JSON.parse(String(jsonLog));
    expect(payload.workspace).toBe(sharedWorkspace);
    expect(payload.workspaceRemoved).toBe(false);
  });
});
