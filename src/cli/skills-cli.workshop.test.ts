// Skills workshop CLI tests cover argument wiring, output, and the offline fallback.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { registerSkillsCli } from "./skills-cli.js";

const mocks = vi.hoisted(() => ({
  acquireGatewayLock: vi.fn(),
  archiveWorkshopSkill: vi.fn(),
  callGateway: vi.fn(),
  config: {},
  listWorkshopChanges: vi.fn(),
  restoreWorkshopSkill: vi.fn(),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  },
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.defaultRuntime,
}));
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: mocks.callGateway,
  isGatewayClientRequestError: () => false,
  isGatewayCredentialsRequiredError: () => false,
  isImplicitLocalGatewayTarget: async () => true,
}));
vi.mock("../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-lock.js")>()),
  acquireGatewayLock: mocks.acquireGatewayLock,
}));
vi.mock("../skills/workshop/library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/workshop/library.js")>()),
  archiveWorkshopSkill: mocks.archiveWorkshopSkill,
  listWorkshopChanges: mocks.listWorkshopChanges,
  restoreWorkshopSkill: mocks.restoreWorkshopSkill,
  viewWorkshopSkill: vi.fn(),
}));
vi.mock("../skills/workshop/workshop-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/workshop/workshop-list.js")>()),
  buildSkillsWorkshopListResult: vi.fn(),
}));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => mocks.config,
  resetConfigRuntimeState: () => undefined,
}));
vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  resolveConfiguredAgentId: (_config: unknown, agentId: string) => agentId,
  resolveAgentIdByWorkspacePath: () => undefined,
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
}));

const change = {
  id: "change-1",
  agentId: "writer",
  skillName: "release-notes",
  action: "archive",
  actor: "user",
  summary: "archived: superseded",
  versionId: "20260929T010203004Z-archive",
  createdAtMs: Date.now() - 5 * 60_000,
};

function runCli(argv: string[]) {
  const program = new Command().enablePositionalOptions();
  program.exitOverride();
  registerSkillsCli(program);
  return program.parseAsync(argv, { from: "user" });
}

describe("skills workshop cli", () => {
  beforeEach(() => {
    mocks.callGateway.mockReset();
    mocks.acquireGatewayLock.mockReset().mockRejectedValue(new Error("lock held"));
    mocks.archiveWorkshopSkill.mockReset();
    mocks.listWorkshopChanges.mockReset();
    mocks.restoreWorkshopSkill.mockReset();
    for (const fn of Object.values(mocks.defaultRuntime)) {
      fn.mockClear();
    }
  });

  it.each([
    {
      argv: ["skills", "workshop", "--agent", "writer", "list"],
      method: "skills.workshop.list",
      params: { agentId: "writer" },
    },
    {
      argv: ["skills", "workshop", "changes", "--limit", "5", "--agent", "writer"],
      method: "skills.workshop.changes",
      params: { agentId: "writer", limit: 5 },
    },
    {
      argv: ["skills", "workshop", "show", "release-notes", "--file", "references/a.md"],
      method: "skills.workshop.read",
      params: { agentId: "main", name: "release-notes", filePath: "references/a.md" },
    },
    {
      argv: ["skills", "workshop", "show", "release-notes", "--version", "v1"],
      method: "skills.workshop.read",
      params: { agentId: "main", name: "release-notes", versionId: "v1" },
    },
    {
      argv: ["skills", "workshop", "archive", "release-notes", "--reason", "superseded"],
      method: "skills.workshop.archive",
      params: { agentId: "main", name: "release-notes", reason: "superseded" },
    },
    {
      argv: ["skills", "workshop", "restore", "release-notes", "--version", "v1"],
      method: "skills.workshop.restore",
      params: { agentId: "main", name: "release-notes", versionId: "v1" },
    },
  ])("sends $method for $argv", async ({ argv, method, params }) => {
    mocks.callGateway.mockResolvedValue({ changes: [], change, content: "", skills: [] });

    await runCli([...argv, "--json"]);

    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(mocks.callGateway.mock.calls[0]?.[0]).toMatchObject({ method, params });
    expect(mocks.callGateway.mock.calls[0]?.[0].params).toStrictEqual(params);
  });

  it("renders learned skills, archived skills, and changes as text", async () => {
    mocks.callGateway.mockResolvedValueOnce({
      agentId: "main",
      mode: "auto",
      root: "/tmp/agent/workshop-skills",
      skills: [
        {
          name: "release-notes",
          description: "Draft release notes from merged PRs",
          updatedAtMs: Date.now() - 2 * 3_600_000,
          sizeBytes: 120,
          files: ["SKILL.md"],
          useCount: 3,
        },
      ],
      archived: [
        {
          name: "old-deploy",
          live: false,
          versions: [{ id: "v2", action: "archive", createdAtMs: 1 }],
        },
        {
          name: "release-notes",
          live: true,
          versions: [{ id: "v1", action: "patch", createdAtMs: 1 }],
        },
      ],
    });
    await runCli(["skills", "workshop", "list"]);
    const listed = mocks.defaultRuntime.writeStdout.mock.calls[0]?.[0] as string;
    expect(listed).toContain("release-notes");
    expect(listed).toContain("updated 2h ago  uses=3  Draft release notes from merged PRs");
    expect(listed).toMatch(/Archived:[^\n]*\nold-deploy {2}versions=1\n$/);

    mocks.callGateway.mockResolvedValueOnce({ changes: [change] });
    await runCli(["skills", "workshop", "changes"]);
    expect(mocks.defaultRuntime.writeStdout).toHaveBeenLastCalledWith(
      "5m ago  user  archive  release-notes  archived: superseded  version=20260929T010203004Z-archive\n",
    );
  });

  const gatewayClosed = () =>
    new GatewayTransportError({
      kind: "closed",
      code: 1006,
      reason: "abnormal closure",
      message: "gateway closed (1006): abnormal closure",
      connectionDetails: {
        url: "ws://127.0.0.1:18789",
        urlSource: "local loopback",
        message: "",
      },
    });

  it("archives locally as the user without a Gateway while holding the Gateway lock", async () => {
    const release = vi.fn();
    mocks.acquireGatewayLock.mockResolvedValue({
      run: (action: () => unknown) => action(),
      release,
    });
    mocks.archiveWorkshopSkill.mockResolvedValue(change);

    await runCli(["skills", "workshop", "archive", "release-notes", "--reason", "superseded"]);

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.archiveWorkshopSkill).toHaveBeenCalledWith(
      { config: mocks.config, agentId: "main", actor: "user" },
      { name: "release-notes", reason: "superseded" },
    );
    expect(release).toHaveBeenCalledOnce();
    expect(mocks.defaultRuntime.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("Archived release-notes. Undo with:"),
    );
  });

  it("never replays a mutation locally after dispatching it to the Gateway", async () => {
    // The Gateway owns the lock until it receives the restore, then exits before replying.
    mocks.acquireGatewayLock.mockImplementation(async () => {
      if (mocks.callGateway.mock.calls.length === 0) {
        throw new Error("lock held");
      }
      return { run: (action: () => unknown) => action(), release: vi.fn() };
    });
    mocks.callGateway.mockRejectedValue(gatewayClosed());

    await expect(runCli(["skills", "workshop", "restore", "release-notes"])).rejects.toThrow(
      "gateway closed (1006)",
    );

    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(mocks.callGateway.mock.calls[0]?.[0]).toMatchObject({
      method: "skills.workshop.restore",
    });
    expect(mocks.restoreWorkshopSkill).not.toHaveBeenCalled();
  });

  it("falls back to local reads when the Gateway is unavailable", async () => {
    mocks.callGateway.mockRejectedValue(gatewayClosed());
    mocks.listWorkshopChanges.mockResolvedValue([change]);

    await runCli(["skills", "workshop", "changes", "--json"]);

    expect(mocks.listWorkshopChanges).toHaveBeenCalledOnce();
    expect(mocks.acquireGatewayLock).not.toHaveBeenCalled();
  });
});
