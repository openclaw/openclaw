import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  metadata: vi.fn(),
  providers: vi.fn(),
  provenance: vi.fn(),
  displayProvenance: vi.fn(),
  summaryMetadata: new Map([
    [
      "telegram",
      { label: "Telegram", defaultAccountId: "default", visibleInConfiguredLists: true },
    ],
  ]),
  config: vi.fn(),
  bindings: vi.fn(),
}));

// mock-isolation: List fixture-owned configurations without reading operator state.
vi.mock("./config-validation.js", () => ({ requireValidConfig: mocks.config }));

// mock-isolation: Control provider summaries without loading channel runtimes.
vi.mock("./agents.providers.js", () => ({
  buildProviderStatusIndex: mocks.status,
  buildProviderSummaryMetadataIndex: mocks.metadata,
  listProvidersForAgent: mocks.providers,
  summarizeBindings: mocks.bindings,
}));

// mock-isolation: Control provenance rows without opening the state database.
vi.mock("../state/agent-provenance.js", () => ({
  listAgentProvenance: mocks.provenance,
  readAgentProvenanceForDisplay: mocks.displayProvenance,
}));

const { agentsListCommand } = await import("./agents.commands.list.js");

async function list(options: Parameters<typeof agentsListCommand>[0]) {
  const runtime = {
    ...createTestRuntime(),
    writeStdout: vi.fn<OutputRuntimeEnv["writeStdout"]>(),
    writeJson: vi.fn<OutputRuntimeEnv["writeJson"]>(),
  };
  await agentsListCommand(options, runtime);
  return {
    json: runtime.writeJson.mock.calls[0]?.[0],
    text: runtime.log.mock.calls.flat().join("\n"),
  };
}

const telegramBinding = [{ agentId: "main", match: { channel: "telegram" } }];
function setEntries(
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
  bindings?: OpenClawConfig["bindings"],
) {
  mocks.config.mockResolvedValue({ agents: { entries }, bindings } satisfies OpenClawConfig);
}

describe("agentsListCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEntries({ main: {} }, telegramBinding);
    mocks.status.mockResolvedValue(new Map());
    mocks.metadata.mockReturnValue(mocks.summaryMetadata);
    mocks.providers.mockReturnValue(["Telegram default: configured"]);
    mocks.provenance.mockResolvedValue([]);
    mocks.displayProvenance.mockResolvedValue([]);
    mocks.bindings.mockReturnValue(["Telegram default"]);
  });
  it("keeps the migrated default in JSON after reloading explicit ownership", async () => {
    const migrated = createCanonicalAgentConfigFixture({
      agents: { list: ["main", "research"].map((id) => ({ id, default: id === "research" })) },
    }).config;
    const persisted = structuredClone<OpenClawConfig>({
      ...migrated,
      agents: { ...migrated.agents, ownership: "explicit" },
    });
    for (const config of [migrated, persisted]) {
      mocks.config.mockResolvedValueOnce(config);
      expect((await list({ json: true })).json).toMatchObject([
        { id: "main", isDefault: false },
        { id: "research", isDefault: true },
      ]);
    }
  });
  it("adds durable provenance to JSON without loading provider details", async () => {
    mocks.provenance.mockRejectedValue(new Error("unrelated stored provenance is invalid"));
    mocks.displayProvenance.mockResolvedValue([
      { agentId: "main", createdVia: "operator", creatorAgentId: null, createdAtMs: 42 },
    ]);
    const { json } = await list({ json: true });
    expect(mocks.status).not.toHaveBeenCalled();
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
    setEntries({
      main: { name: "Main" },
      child: { name: "Child" },
      legacy: { name: "Legacy" },
      orphan: { name: "Orphan" },
    });
    mocks.provenance.mockResolvedValue([
      { agentId: "main", createdVia: "operator", creatorAgentId: null, createdAtMs: 1 },
      { agentId: "child", createdVia: "agent", creatorAgentId: "main", createdAtMs: 2 },
      { agentId: "orphan", createdVia: "agent", creatorAgentId: "deleted", createdAtMs: 3 },
    ]);
    expect((await list({ tree: true })).text).toBe(
      "Agents:\n- main (Main)\n  - child (Child)\n- legacy (Legacy)\n- orphan (Orphan)",
    );
    expect(mocks.status).not.toHaveBeenCalled();
  });
  it("lists configured, inherited, and local avatar identities without changing the workspace", async () => {
    await withTestDir({ prefix: "openclaw-agent-identity-list-" }, async (workspace) => {
      const identityPath = path.join(workspace, "IDENTITY.md");
      const identityFile = "- Name: Workspace\n- Emoji: 🦞\n- Avatar: https://e.test/w.png\n";
      fs.writeFileSync(identityPath, identityFile);
      fs.writeFileSync(path.join(workspace, "avatar.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const agent = (identity: IdentityConfig) => ({ workspace, identity });
      setEntries({
        configured: agent({
          name: " Chosen ",
          emoji: "🦉",
          avatar: "https://e.test/n.png",
        }),
        partial: agent({ name: "Chosen" }),
        fallback: agent({ name: " ", emoji: "\t", avatar: "slack://avatar.png" }),
        local: agent({ avatar: "avatar.png" }),
        bare: { workspace: path.join(workspace, "empty") },
      });
      const { json } = await list({ json: true });
      expect(json).toMatchObject([
        ...[
          ["configured", "Chosen", "🦉", "https://e.test/n.png", "config"],
          ["partial", "Chosen", "🦞", "https://e.test/w.png", "config"],
          ["fallback", "Workspace", "🦞", "https://e.test/w.png", "identity"],
        ].map(([id, identityName, identityEmoji, identityAvatarUrl, identitySource]) => ({
          id,
          identityName,
          identityEmoji,
          identityAvatarUrl,
          identitySource,
        })),
        {
          id: "local",
          identityAvatarUrl: "data:image/png;base64,iVBORw==",
          identitySource: "config",
        },
        { id: "bare" },
      ]);
      expect(json).not.toHaveProperty("4.identityAvatarUrl");
      const { text: output } = await list({});
      expect(output).toContain("Identity: 🦉 Chosen (config)");
      expect(output).toContain("Identity: 🦞 Chosen (config)");
      expect(output).toContain("Identity: 🦞 Workspace (IDENTITY.md)");
      expect(fs.readFileSync(identityPath, "utf8")).toBe(identityFile);
    });
  });
  it("sanitizes configured agent text without changing JSON summaries", async () => {
    const control = "\u001B]0;agents-list-injection\u0007";
    const identityName = `${control}Operator 🦞\r\nforged-row`;
    const workspace = `/tmp/workspace-${control}\tpath`;
    const model = `${control}provider/model\nvariant`;
    setEntries(
      {
        main: {
          name: `${control}Main\nAlias`,
          workspace,
          agentDir: `/tmp/agent-${control}\npath`,
          model,
          identity: { name: identityName },
        },
      },
      telegramBinding,
    );
    mocks.bindings.mockReturnValue([`${control}Telegram\nroute`]);
    mocks.providers.mockReturnValue([`${control}Telegram\tconfigured`]);
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
        setEntries({
          main: {
            workspace: path.join(homeAlias, "workspace"),
            agentDir: path.join(homeAlias, "agents", "main", "agent"),
          },
        });
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
