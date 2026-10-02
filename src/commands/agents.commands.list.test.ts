import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const {
  buildProviderStatusIndexMock,
  buildProviderSummaryMetadataIndexMock,
  listProvidersForAgentMock,
  listAgentProvenanceMock,
  readAgentProvenanceForDisplayMock,
  providerSummaryMetadataMock,
  requireValidConfigMock,
  summarizeBindingsMock,
} = vi.hoisted(() => ({
  buildProviderStatusIndexMock: vi.fn(),
  buildProviderSummaryMetadataIndexMock: vi.fn(),
  listProvidersForAgentMock: vi.fn(),
  listAgentProvenanceMock: vi.fn(),
  readAgentProvenanceForDisplayMock: vi.fn(),
  providerSummaryMetadataMock: new Map([
    [
      "telegram",
      {
        label: "Telegram",
        defaultAccountId: "default",
        visibleInConfiguredLists: true,
      },
    ],
  ]),
  requireValidConfigMock: vi.fn(),
  summarizeBindingsMock: vi.fn(),
}));

vi.mock("./config-validation.js", () => ({
  requireValidConfig: requireValidConfigMock,
}));

vi.mock("./agents.providers.js", () => ({
  buildProviderStatusIndex: buildProviderStatusIndexMock,
  buildProviderSummaryMetadataIndex: buildProviderSummaryMetadataIndexMock,
  listProvidersForAgent: listProvidersForAgentMock,
  summarizeBindings: summarizeBindingsMock,
}));

vi.mock("../state/agent-provenance.js", () => ({
  listAgentProvenance: listAgentProvenanceMock,
  readAgentProvenanceForDisplay: readAgentProvenanceForDisplayMock,
}));

const { agentsListCommand } = await import("./agents.commands.list.js");

function createRuntime() {
  return {
    ...createTestRuntime(),
    writeStdout: vi.fn<OutputRuntimeEnv["writeStdout"]>(),
    writeJson: vi.fn<OutputRuntimeEnv["writeJson"]>(),
  };
}

async function list(options: Parameters<typeof agentsListCommand>[0]) {
  const runtime = createRuntime();
  await agentsListCommand(options, runtime);
  return {
    json: runtime.writeJson.mock.calls[0]?.[0],
    text: runtime.log.mock.calls.flat().join("\n"),
  };
}

function createConfig(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true }],
    },
    bindings: [{ agentId: "main", match: { channel: "telegram" } }],
  };
}

describe("agentsListCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireValidConfigMock.mockResolvedValue(createConfig());
    buildProviderStatusIndexMock.mockResolvedValue(new Map());
    buildProviderSummaryMetadataIndexMock.mockReturnValue(providerSummaryMetadataMock);
    listProvidersForAgentMock.mockReturnValue(["Telegram default: configured"]);
    listAgentProvenanceMock.mockResolvedValue([]);
    readAgentProvenanceForDisplayMock.mockResolvedValue([]);
    summarizeBindingsMock.mockReturnValue(["Telegram default"]);
  });

  it("keeps the migrated default in JSON after reloading explicit ownership", async () => {
    const agentId = "research";
    const legacy: OpenClawConfig = {
      agents: {
        list: ["main", "research"].map((id) => ({ id, default: id === agentId })),
      },
    };
    const migrated = createCanonicalAgentConfigFixture(legacy).config;
    const persisted = structuredClone<OpenClawConfig>({
      ...migrated,
      agents: { ...migrated.agents, ownership: "explicit" },
    });
    for (const config of [legacy, persisted]) {
      requireValidConfigMock.mockResolvedValueOnce(config);
      expect((await list({ json: true })).json).toMatchObject([
        { id: "main", isDefault: false },
        { id: "research", isDefault: true },
      ]);
    }
  });

  it("reports no default without a designation despite retained provenance", async () => {
    const config = retainLegacyDefaultAgentId(
      {
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      },
      "ops",
    );
    requireValidConfigMock.mockResolvedValueOnce(config);
    expect((await list({ json: true })).json).toMatchObject([
      { id: "ops", isDefault: false },
      { id: "research", isDefault: false },
    ]);
  });

  it("adds durable provenance to JSON without loading provider details", async () => {
    listAgentProvenanceMock.mockRejectedValue(new Error("unrelated stored provenance is invalid"));
    readAgentProvenanceForDisplayMock.mockResolvedValue([
      {
        agentId: "main",
        createdVia: "operator",
        creatorAgentId: null,
        createdAtMs: 42,
      },
    ]);

    const { json } = await list({ json: true });
    expect(buildProviderStatusIndexMock).not.toHaveBeenCalled();
    expect(json).toMatchObject([
      { id: "main", createdVia: "operator", creatorAgentId: null, createdAt: 42 },
    ]);
    for (const field of ["routes", "providers"]) {
      expect(json).not.toHaveProperty(`0.${field}`);
    }

    await expect(list({ json: true, tree: true })).rejects.toThrow(
      "unrelated stored provenance is invalid",
    );
  });

  it("renders roots, children, missing rows, and dangling creators as a tree", async () => {
    requireValidConfigMock.mockResolvedValueOnce({
      agents: {
        entries: {
          main: { name: "Main" },
          child: { name: "Child" },
          legacy: { name: "Legacy" },
          orphan: { name: "Orphan" },
        },
      },
    } satisfies OpenClawConfig);
    listAgentProvenanceMock.mockResolvedValue([
      { agentId: "main", createdVia: "operator", creatorAgentId: null, createdAtMs: 1 },
      { agentId: "child", createdVia: "agent", creatorAgentId: "main", createdAtMs: 2 },
      { agentId: "orphan", createdVia: "agent", creatorAgentId: "deleted", createdAtMs: 3 },
    ]);
    expect((await list({ tree: true })).text).toBe(
      [
        "Agents:",
        "- main (Main)",
        "  - child (Child)",
        "- legacy (Legacy)",
        "- orphan (Orphan)",
      ].join("\n"),
    );
    expect(buildProviderStatusIndexMock).not.toHaveBeenCalled();
  });

  it("keeps provider details available for JSON callers that request bindings", async () => {
    const { json } = await list({ json: true, bindings: true });
    expect(json).toMatchObject([
      { id: "main", routes: ["Telegram default"], providers: ["Telegram default: configured"] },
    ]);
    for (const field of ["createdVia", "creatorAgentId", "createdAt"]) {
      expect(json).not.toHaveProperty(`0.${field}`);
    }
  });

  it("lists configured, inherited, and local avatar identities without changing the workspace", async () => {
    await withTestDir({ prefix: "openclaw-agent-identity-list-" }, async (workspace) => {
      const identityPath = path.join(workspace, "IDENTITY.md");
      const identityFile =
        "- Name: Workspace Identity\n- Emoji: 🦞\n- Avatar: https://example.invalid/workspace.png\n";
      fs.writeFileSync(identityPath, identityFile);
      fs.writeFileSync(path.join(workspace, "avatar.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      requireValidConfigMock.mockResolvedValue({
        agents: {
          entries: {
            configured: {
              workspace,
              identity: {
                name: " Chosen Identity ",
                emoji: "🦉",
                avatar: "https://example.invalid/new.png",
              },
            },
            partial: { workspace, identity: { name: "Chosen Identity" } },
            fallback: {
              workspace,
              identity: { name: " ", emoji: "\t", avatar: "slack://avatar.png" },
            },
            local: { workspace, identity: { avatar: "avatar.png" } },
            bare: { workspace: path.join(workspace, "empty") },
          },
        },
      } satisfies OpenClawConfig);
      const { json } = await list({ json: true });
      expect(json).toMatchObject([
        {
          id: "configured",
          identityName: "Chosen Identity",
          identityEmoji: "🦉",
          identityAvatarUrl: "https://example.invalid/new.png",
          identitySource: "config",
        },
        {
          id: "partial",
          identityName: "Chosen Identity",
          identityEmoji: "🦞",
          identityAvatarUrl: "https://example.invalid/workspace.png",
          identitySource: "config",
        },
        {
          id: "fallback",
          identityName: "Workspace Identity",
          identityEmoji: "🦞",
          identityAvatarUrl: "https://example.invalid/workspace.png",
          identitySource: "identity",
        },
        {
          id: "local",
          identityAvatarUrl: "data:image/png;base64,iVBORw==",
          identitySource: "config",
        },
        { id: "bare" },
      ]);
      expect(json).not.toHaveProperty("4.identityAvatarUrl");
      const { text: output } = await list({});
      expect(output).toContain("Identity: 🦉 Chosen Identity (config)");
      expect(output).toContain("Identity: 🦞 Chosen Identity (config)");
      expect(output).toContain("Identity: 🦞 Workspace Identity (IDENTITY.md)");
      expect(fs.readFileSync(identityPath, "utf8")).toBe(identityFile);
    });
  });

  it("keeps JSON identity fields when local avatar preparation fails", async () => {
    await withTestDir({ prefix: "openclaw-agent-identity-list-" }, async (workspace) => {
      const avatarRuntime = await import("../agents/identity-avatar-file-runtime.js");
      const prepareAvatar = vi
        .spyOn(avatarRuntime, "prepareLocalAgentAvatar")
        .mockRejectedValue(new Error("avatar worker unavailable"));
      try {
        requireValidConfigMock.mockResolvedValueOnce({
          agents: {
            entries: {
              proof: {
                workspace,
                identity: { name: "Chosen Identity", emoji: "🦉", avatar: "avatar.png" },
              },
            },
          },
        } satisfies OpenClawConfig);
        const { json } = await list({ json: true });
        expect(prepareAvatar).toHaveBeenCalledOnce();
        expect(json).toMatchObject([
          {
            id: "proof",
            identityName: "Chosen Identity",
            identityEmoji: "🦉",
            identitySource: "config",
          },
        ]);
        expect(json).not.toHaveProperty("0.identityAvatarUrl");
      } finally {
        prepareAvatar.mockRestore();
      }
    });
  });

  it("sanitizes configured agent text without changing JSON summaries", async () => {
    const control = "\u001B]0;agents-list-injection\u0007";
    const identityName = `${control}Operator 🦞\r\nforged-row`;
    const workspace = `/tmp/workspace-${control}\tpath`;
    const model = `${control}provider/model\nvariant`;
    const cfg = {
      agents: {
        entries: {
          main: {
            name: `${control}Main\nAlias`,
            workspace,
            agentDir: `/tmp/agent-${control}\npath`,
            model,
            identity: { name: identityName },
          },
        },
      },
      bindings: [{ agentId: "main", match: { channel: "telegram" } }],
    } satisfies OpenClawConfig;
    requireValidConfigMock.mockResolvedValue(cfg);
    summarizeBindingsMock.mockReturnValue([`${control}Telegram\nroute`]);
    listProvidersForAgentMock.mockReturnValue([`${control}Telegram\tconfigured`]);

    const { text: textOutput } = await list({ bindings: true });
    expect(textOutput).not.toContain("\u001B");
    expect(textOutput).not.toContain("\nforged-row");
    expect(textOutput).toContain("Operator 🦞\\r\\nforged-row");
    expect(textOutput).toContain("provider/model\\nvariant");
    expect(textOutput).toContain("Telegram\\nroute");

    expect((await list({ json: true })).json).toMatchObject([
      { identityName, model, workspace: expect.stringContaining(control) },
    ]);
  });

  it.skipIf(process.platform !== "win32")(
    "shortens real Windows home casing aliases in human output",
    async () => {
      await withTestDir({ prefix: "openclaw-home-display-" }, async (home) => {
        const workspace = path.join(home, "workspace");
        const agentDir = path.join(home, "agents", "main", "agent");
        await fs.promises.mkdir(workspace, { recursive: true });
        await fs.promises.mkdir(agentDir, { recursive: true });
        const homeAlias = home.toUpperCase();
        expect(fs.statSync(homeAlias).isDirectory()).toBe(true);

        requireValidConfigMock.mockResolvedValueOnce({
          agents: {
            list: [
              {
                id: "main",
                default: true,
                workspace: path.join(homeAlias, "workspace"),
                agentDir: path.join(homeAlias, "agents", "main", "agent"),
              },
            ],
          },
        } satisfies OpenClawConfig);
        const { text: output } = await withEnvAsync({ OPENCLAW_HOME: home }, () => list({}));
        expect(output).toContain(`Workspace: $OPENCLAW_HOME${path.sep}workspace`);
        expect(output).toContain(
          `Agent dir: $OPENCLAW_HOME${path.sep}agents${path.sep}main${path.sep}agent`,
        );
        expect(output).not.toContain(homeAlias);
      });
    },
  );
});
