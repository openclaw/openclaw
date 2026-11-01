import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { registerSkillsCli } from "./skills-cli.js";

const mocks = await vi.hoisted(async () => {
  const { runtimeFixture } = await import("./skills-cli.test-support.js");
  return {
    acquireGatewayLock: vi.fn(),
    archiveWorkshopSkill: vi.fn(),
    callGateway: vi.fn(),
    config: {},
    listWorkshopChanges: vi.fn(),
    restoreWorkshopSkill: vi.fn(),
    defaultRuntime: runtimeFixture(true).runtime,
  };
});

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
  loadConfig: () => mocks.config,
  captureRuntimeConfigAsyncReader: () => async () => mocks.config,
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
const context = { config: mocks.config, agentId: "writer", actor: "user" };
const namedSkill = { agentId: "main", name: "release-notes" };
const version = { ...namedSkill, versionId: "v1" };
const archivedVersion = (id: string, action: string) => ({ id, action, createdAtMs: 1 });
const gatewayClosed = () =>
  new GatewayTransportError({
    kind: "closed",
    code: 1006,
    reason: "abnormal closure",
    message: "gateway closed (1006): abnormal closure",
    connectionDetails: { url: "ws://127.0.0.1:18789", urlSource: "local loopback", message: "" },
  });

function runCli(args: string | string[]) {
  const program = new Command().enablePositionalOptions();
  program.exitOverride();
  registerSkillsCli(program);
  return program.parseAsync(typeof args === "string" ? args.split(" ") : args, { from: "user" });
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
    ["--agent writer list", "list", { agentId: "writer" }],
    ["changes --limit 5 --agent writer", "changes", { agentId: "writer", limit: 5 }],
    [
      "show release-notes --file references/a.md",
      "read",
      { ...namedSkill, filePath: "references/a.md" },
    ],
    ["show release-notes --version v1", "read", version],
    [
      "archive release-notes --reason superseded",
      "archive",
      { ...namedSkill, reason: "superseded" },
    ],
    ["restore release-notes --version v1", "restore", version],
  ] as const)("routes %s to %s", async (argv, method, params) => {
    mocks.callGateway.mockResolvedValue({ changes: [], change, content: "", skills: [] });

    await runCli(`skills workshop ${argv} --json`);

    expect(mocks.callGateway).toHaveBeenCalledOnce();
    const request = mocks.callGateway.mock.calls[0]?.[0];
    expect([request.method, request.params]).toStrictEqual([`skills.workshop.${method}`, params]);
  });

  it("rejects an explicitly blank --version instead of restoring the newest version", async () => {
    mocks.callGateway.mockResolvedValue({ change });

    await expect(
      runCli(["skills", "workshop", "restore", "release-notes", "--version", ""]),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.restoreWorkshopSkill).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.error.mock.calls[0]?.[0]).toContain("--version must not be blank");
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
        { name: "old-deploy", live: false, versions: [archivedVersion("v2", "archive")] },
        { name: "release-notes", live: true, versions: [archivedVersion("v1", "patch")] },
      ],
    });
    await runCli("skills workshop list");
    const listed = mocks.defaultRuntime.writeStdout.mock.calls[0]?.[0] as string;
    expect(listed).toContain("release-notes");
    expect(listed).toContain("updated 2h ago  uses=3  Draft release notes from merged PRs");
    expect(listed).toMatch(/Archived:[^\n]*\nold-deploy {2}versions=1\n$/);

    mocks.callGateway.mockResolvedValueOnce({ changes: [change] });
    await runCli("skills workshop changes");
    expect(mocks.defaultRuntime.writeStdout).toHaveBeenLastCalledWith(
      "5m ago  user  archive  release-notes  archived: superseded  version=20260929T010203004Z-archive\n",
    );
  });

  it.each([
    [
      "archive",
      "--reason superseded",
      { name: "release-notes", reason: "superseded" },
      "Archived release-notes. Undo with:",
    ],
    [
      "restore",
      "--version saved-v1",
      { name: "release-notes", versionId: "saved-v1" },
      "Restored release-notes.\n",
    ],
  ] as const)(
    "runs %s locally as the user while holding the Gateway lock",
    async (method, args, params, output) => {
      const release = vi.fn();
      mocks.acquireGatewayLock.mockResolvedValue({
        run: (action: () => unknown) => action(),
        release,
      });
      const mutate = method === "archive" ? mocks.archiveWorkshopSkill : mocks.restoreWorkshopSkill;
      mutate.mockResolvedValue(change);
      if (method === "archive") {
        mocks.restoreWorkshopSkill.mockResolvedValue({ ...change, action: "restore" });
      }

      await runCli(`skills workshop ${method} release-notes --agent writer ${args}`);

      expect(mocks.callGateway).not.toHaveBeenCalled();
      expect(mutate).toHaveBeenCalledWith(context, params);
      expect(release).toHaveBeenCalledOnce();
      expect(mocks.defaultRuntime.writeStdout).toHaveBeenCalledWith(
        expect.stringContaining(output),
      );
      if (method === "archive") {
        const [, undo] = mocks.defaultRuntime.writeStdout.mock
          .lastCall![0].trim()
          .split("Undo with: ");
        expect(undo).toMatch(/^openclaw /);
        await runCli(undo!.split(" ").slice(1));
        expect(mocks.restoreWorkshopSkill).toHaveBeenCalledWith(context, {
          name: "release-notes",
          versionId: undefined,
        });
      }
    },
  );

  it("falls back to local reads when the Gateway is unavailable", async () => {
    mocks.callGateway.mockRejectedValue(gatewayClosed());
    mocks.listWorkshopChanges.mockResolvedValue([change]);

    await runCli("skills workshop changes --json");

    expect(mocks.listWorkshopChanges).toHaveBeenCalledOnce();
    expect(mocks.acquireGatewayLock).not.toHaveBeenCalled();
  });
});
