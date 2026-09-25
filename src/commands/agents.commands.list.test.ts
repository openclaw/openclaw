// Agent command-list tests cover provider metadata and command output for configured agents.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
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

  it.each(["main", "research"])(
    "keeps migrated default %s in JSON after reloading persisted explicit ownership",
    async (agentId) => {
      const legacy: OpenClawConfig = {
        agents: {
          list: ["main", "research"].map((id) => ({ id, default: id === agentId })),
        },
      };
      const migrated = migratePersistedImplicitMainRoster(legacy).config as OpenClawConfig;
      const persisted = structuredClone<OpenClawConfig>({
        ...migrated,
        agents: { ...migrated.agents, ownership: "explicit" },
      });
      expect(persisted.agents?.defaults?.systemAgent?.agentId).toBe(agentId);
      expect(Object.values(persisted.agents?.entries ?? {}).some((entry) => entry.default)).toBe(
        false,
      );

      for (const config of [legacy, persisted]) {
        requireValidConfigMock.mockResolvedValueOnce(config);
        const runtime = createRuntime();
        await agentsListCommand({ json: true }, runtime);
        expect(runtime.writeJson.mock.calls[0]?.[0]).toEqual(
          ["main", "research"].map((id) =>
            expect.objectContaining({ id, isDefault: id === agentId }),
          ),
        );
      }
    },
  );

  it.each([undefined, "ops"])(
    "reports no default without a designation despite provenance %s",
    async (retainedAgentId) => {
      const config = retainLegacyDefaultAgentId(
        {
          agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
        },
        retainedAgentId,
      );
      requireValidConfigMock.mockResolvedValueOnce(config);
      const runtime = createRuntime();
      await agentsListCommand({ json: true }, runtime);
      expect(runtime.writeJson.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ id: "ops", isDefault: false }),
        expect.objectContaining({ id: "research", isDefault: false }),
      ]);
    },
  );

  it("adds durable provenance to JSON without loading provider details", async () => {
    const runtime = createRuntime();
    listAgentProvenanceMock.mockRejectedValue(new Error("unrelated stored provenance is invalid"));
    readAgentProvenanceForDisplayMock.mockResolvedValue([
      {
        agentId: "main",
        createdVia: "operator",
        creatorAgentId: null,
        createdAtMs: 42,
      },
    ]);

    await agentsListCommand({ json: true }, runtime);

    expect(buildProviderStatusIndexMock).not.toHaveBeenCalled();
    const output = runtime.writeJson.mock.calls[0]?.[0];
    const summary = (output as Array<Record<string, unknown>>)[0];
    expect(summary?.id).toBe("main");
    expect(summary).toMatchObject({
      createdVia: "operator",
      creatorAgentId: null,
      createdAt: 42,
    });
    expect(summary).not.toHaveProperty("routes");
    expect(summary).not.toHaveProperty("providers");

    await expect(agentsListCommand({ json: true, tree: true }, createRuntime())).rejects.toThrow(
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
    const runtime = createRuntime();

    await agentsListCommand({ tree: true }, runtime);

    expect(runtime.log).toHaveBeenCalledWith(
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
    const runtime = createRuntime();
    const cfg = createConfig();
    const providerStatus = new Map();
    requireValidConfigMock.mockResolvedValueOnce(cfg);
    buildProviderStatusIndexMock.mockResolvedValueOnce(providerStatus);

    await agentsListCommand({ json: true, bindings: true }, runtime);

    expect(buildProviderStatusIndexMock).toHaveBeenCalledOnce();
    expect(buildProviderSummaryMetadataIndexMock).toHaveBeenCalledOnce();
    expect(summarizeBindingsMock).toHaveBeenCalledWith(
      cfg,
      cfg.bindings,
      providerSummaryMetadataMock,
    );
    expect(listProvidersForAgentMock).toHaveBeenCalledWith({
      summaryIsDefault: true,
      cfg,
      bindings: cfg.bindings,
      providerStatus,
      providerMetadata: providerSummaryMetadataMock,
    });
    const output = runtime.writeJson.mock.calls[0]?.[0];
    const [summary] = output as Array<Record<string, unknown>>;
    expect(summary?.id).toBe("main");
    expect(summary?.routes).toEqual(["Telegram default"]);
    expect(summary?.providers).toEqual(["Telegram default: configured"]);
    expect(summary).not.toHaveProperty("createdVia");
    expect(summary).not.toHaveProperty("creatorAgentId");
    expect(summary).not.toHaveProperty("createdAt");
  });

  it("keeps human output enriched from read-only provider metadata", async () => {
    const runtime = createRuntime();

    await agentsListCommand({}, runtime);

    expect(buildProviderStatusIndexMock).toHaveBeenCalledOnce();
    expect(buildProviderSummaryMetadataIndexMock).toHaveBeenCalledOnce();
    expect(runtime.log.mock.calls).toEqual([
      [
        [
          "Agents:",
          "- main (default)",
          `  Workspace: ~${path.sep}.openclaw${path.sep}workspace`,
          `  Agent dir: ~${path.sep}.openclaw${path.sep}agents${path.sep}main${path.sep}agent`,
          "  Routing rules: 1",
          "  Routing: Telegram default",
          "  Providers:",
          "    - Telegram default: configured",
          "Routing rules map channel/account/peer to an agent. Use --bindings for full rules.",
          "Channel status reflects local config/creds. For live health: openclaw channels status --probe.",
        ].join("\n"),
      ],
    ]);
  });

  it.each([
    {
      label: "configured",
      identity: {
        name: " Chosen Identity ",
        emoji: "🦉",
        avatar: "https://example.invalid/new.png",
      },
      expected: {
        identityName: "Chosen Identity",
        identityEmoji: "🦉",
        identityAvatarUrl: "https://example.invalid/new.png",
        identitySource: "config",
      },
    },
    {
      label: "partially configured",
      identity: { name: "Chosen Identity" },
      expected: {
        identityName: "Chosen Identity",
        identityEmoji: "🦞",
        identityAvatarUrl: "https://example.invalid/workspace.png",
        identitySource: "config",
      },
    },
    ...[
      { label: "workspace-only", identity: undefined },
      { label: "blank configured", identity: { name: " ", emoji: "\t", avatar: " " } },
      { label: "unsupported configured avatar", identity: { avatar: "slack://avatar.png" } },
    ].map(({ label, identity }) => ({
      label,
      identity,
      expected: {
        identityName: "Workspace Identity",
        identityEmoji: "🦞",
        identityAvatarUrl: "https://example.invalid/workspace.png",
        identitySource: "identity",
      },
    })),
  ])("lists $label identity values with workspace fallback", async ({ identity, expected }) => {
    await withTestDir({ prefix: "openclaw-agent-identity-list-" }, async (workspace) => {
      const identityPath = path.join(workspace, "IDENTITY.md");
      const identityFile =
        "# Identity\n\n- Name: Workspace Identity\n- Emoji: 🦞\n- Avatar: https://example.invalid/workspace.png\n";
      fs.writeFileSync(identityPath, identityFile);
      requireValidConfigMock.mockResolvedValue({
        agents: { entries: { proof: { workspace, identity } } },
      } satisfies OpenClawConfig);
      const jsonRuntime = createRuntime();
      await agentsListCommand({ json: true }, jsonRuntime);
      expect(jsonRuntime.writeJson.mock.calls[0]?.[0]).toEqual([expect.objectContaining(expected)]);

      const textRuntime = createRuntime();
      await agentsListCommand({}, textRuntime);
      const source = expected.identitySource === "config" ? "config" : "IDENTITY.md";
      expect(textRuntime.log.mock.calls.flat().join("\n")).toContain(
        `Identity: ${expected.identityEmoji} ${expected.identityName} (${source})`,
      );
      expect(fs.readFileSync(identityPath, "utf8")).toBe(identityFile);
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

    const textRuntime = createRuntime();
    await agentsListCommand({ bindings: true }, textRuntime);

    const textOutput = textRuntime.log.mock.calls.flat().join("\n");
    expect(textOutput).not.toContain("\u001B");
    expect(textOutput).not.toContain("\nforged-row");
    expect(textOutput).toContain("Operator 🦞\\r\\nforged-row");
    expect(textOutput).toContain("provider/model\\nvariant");
    expect(textOutput).toContain("Telegram\\nroute");

    const jsonRuntime = createRuntime();
    await agentsListCommand({ json: true }, jsonRuntime);

    // Workspace paths are platform-normalized before JSON, so assert the
    // non-sanitization invariant on it rather than byte equality.
    const jsonOutput = jsonRuntime.writeJson.mock.calls[0]?.[0];
    expect(jsonOutput).toEqual([expect.objectContaining({ identityName, model })]);
    expect((jsonOutput as Array<{ workspace: string }>)[0]?.workspace).toContain(control);
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
        const runtime = createRuntime();

        await withEnvAsync({ OPENCLAW_HOME: home }, async () => {
          await agentsListCommand({}, runtime);
        });

        const output = runtime.log.mock.calls.flat().join("\n");
        expect(output).toContain(`Workspace: $OPENCLAW_HOME${path.sep}workspace`);
        expect(output).toContain(
          `Agent dir: $OPENCLAW_HOME${path.sep}agents${path.sep}main${path.sep}agent`,
        );
        expect(output).not.toContain(homeAlias);
      });
    },
  );
});
