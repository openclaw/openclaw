import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { IdentityConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultRuntime } from "../runtime.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { withEnvAsync } from "../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  plugins: vi.fn<() => ChannelPlugin[]>(() => []),
  provenance: vi.fn(),
  displayProvenance: vi.fn(),
  config: vi.fn(),
}));

// mock-isolation: List fixture-owned configurations without reading operator state.
vi.mock("./config-validation.js", () => ({ requireValidConfig: mocks.config }));

// mock-isolation: Use synthetic plugin descriptors, retaining the command's real provider projection.
vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.plugins,
}));

// mock-isolation: Control provenance rows without opening the state database.
vi.mock("../state/agent-provenance.js", () => ({
  listAgentProvenance: mocks.provenance,
  readAgentProvenanceForDisplay: mocks.displayProvenance,
}));

const { agentsListCommand } = await import("./agents.commands.list.js");

async function list(options: Parameters<typeof agentsListCommand>[0]) {
  const log = vi.spyOn(defaultRuntime, "log").mockReturnValue(undefined).mockClear();
  const json = vi.spyOn(defaultRuntime, "writeJson").mockReturnValue(undefined).mockClear();
  await agentsListCommand(options);
  return {
    json: json.mock.calls[0]?.[0],
    text: log.mock.calls.flat().join("\n"),
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
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    setEntries({ main: {} }, telegramBinding);
    mocks.plugins.mockReturnValue([
      createChannelTestPluginBase({
        id: "telegram",
        label: "Telegram",
        config: {
          resolveAccount: () => ({ accountId: "default", enabled: true, configured: true }),
          describeAccount: () => ({ accountId: "default", enabled: true, configured: true }),
        },
      }),
    ]);
    mocks.provenance.mockResolvedValue([]);
    mocks.displayProvenance.mockResolvedValue([]);
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
    expect(mocks.plugins).not.toHaveBeenCalled();
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
    expect(mocks.plugins).not.toHaveBeenCalled();
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
    mocks.plugins.mockReturnValue([
      createChannelTestPluginBase({
        id: "telegram",
        label: `${control}Telegram\nroute`,
        config: {
          resolveAccount: () => ({ accountId: "default", enabled: true, configured: true }),
          describeAccount: () => ({
            accountId: "default",
            enabled: true,
            configured: true,
            name: `${control}Telegram\tconfigured`,
          }),
        },
      }),
    ]);
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
