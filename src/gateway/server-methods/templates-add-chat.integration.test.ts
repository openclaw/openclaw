import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveEffectiveToolPolicy } from "../../agents/agent-tools.policy.js";
import { isToolAllowedByPolicies } from "../../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../../agents/tool-policy.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { listConfiguredMcpServers } from "../../config/mcp-config.js";
import {
  registerRuntimeConfigWriteListener,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../../plugins/installed-plugin-index-records.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { ClawHubSourceError } from "../../templates/clawhub-source-artifact.js";
import type { withResolvedClawHubSource } from "../../templates/clawhub-source.js";
import type { TemplateSetupReport } from "../../templates/conversation.js";
import { readTemplateManifestFile } from "../../templates/reader.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { templatesAddHandlers } from "./templates-add.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const { resolveSource, greeting, skills, registry, probe, workspaceWrite } = vi.hoisted(() => ({
  resolveSource: vi.fn(),
  greeting: vi.fn(),
  skills: { preflight: vi.fn(), install: vi.fn() },
  registry: { detail: vi.fn(), artifact: vi.fn(), security: vi.fn(), download: vi.fn() },
  probe: { preflight: vi.fn(), artifact: vi.fn() },
  workspaceWrite: { fail: undefined as string | undefined },
}));
// mock-isolation: Registry delivery of the Template is external I/O. Admission, the
// workspace writer, installers, config writes and session finalization stay real.
vi.mock("../../templates/clawhub-source.js", async (original) => ({
  ...(await original<typeof import("../../templates/clawhub-source.js")>()),
  withResolvedClawHubSource: resolveSource,
}));
// mock-isolation: The registry's skill endpoints are external I/O; the fake writes the
// skill into the workspace it is given. Bundled skills use the real installer.
vi.mock("../../skills/lifecycle/clawhub.js", async (original) => ({
  ...(await original<typeof import("../../skills/lifecycle/clawhub.js")>()),
  preflightSkillFromClawHub: skills.preflight,
  installSkillFromClawHub: skills.install,
}));
// mock-isolation: Sentinels. Chat-based Add must never reach the plugin registry or
// the plugin capability probe for a plugin the Template only references.
vi.mock("../../infra/clawhub-packages.js", async (original) => ({
  ...(await original<typeof import("../../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: registry.detail,
  fetchClawHubPackageArtifact: registry.artifact,
  fetchClawHubPackageSecurity: registry.security,
}));
vi.mock("../../infra/clawhub-artifacts.js", async (original) => ({
  ...(await original<typeof import("../../infra/clawhub-artifacts.js")>()),
  downloadClawHubPackageArchive: registry.download,
}));
vi.mock("../../templates/plugin-capability-probe.js", async (original) => {
  const owner = await original<typeof import("../../templates/plugin-capability-probe.js")>();
  return {
    ...owner,
    preflightTemplatePluginPackage: (
      ...args: Parameters<typeof owner.preflightTemplatePluginPackage>
    ) => {
      probe.preflight(...args);
      return owner.preflightTemplatePluginPackage(...args);
    },
    probeTemplatePluginArtifact: (
      ...args: Parameters<typeof owner.probeTemplatePluginArtifact>
    ) => {
      probe.artifact(...args);
      return owner.probeTemplatePluginArtifact(...args);
    },
  };
});
// mock-isolation: Inject one workspace write failure; ownership and rollback stay real.
vi.mock("../../infra/fs-safe.js", async (original) => {
  const filesystem = await original<typeof import("../../infra/fs-safe.js")>();
  return {
    ...filesystem,
    root: async (...args: Parameters<typeof filesystem.root>) => {
      const root = await filesystem.root(...args);
      return new Proxy(root, {
        get(target, key, receiver) {
          if (key !== "write") {
            return Reflect.get(target, key, receiver);
          }
          return async (...write: Parameters<typeof root.write>) => {
            if (write[0] === workspaceWrite.fail) {
              throw new Error("Fixture workspace disk write failed");
            }
            await root.write(...write);
          };
        },
      });
    },
  };
});
// mock-isolation: No model runs here; the starter's inputs are the hand-off under test.
vi.mock("./agents-onboarding.js", async (original) => ({
  ...(await original<typeof import("./agents-onboarding.js")>()),
  startAgentOnboardingConversation: greeting,
}));
// mock-isolation: There is no websocket roster in this request-owner composition.
vi.mock("./session-change-event.js", () => ({ emitSessionsChanged: vi.fn() }));

afterEach(async () => {
  // Implementations too: one test's first turn must not observe another's Gateway.
  vi.resetAllMocks();
  workspaceWrite.fail = undefined;
  await closeOpenClawStateDatabaseAsync();
});

const coordinate = { packageName: "@fixture/travel-copilot", version: "0.2.8" };
const trust = {
  riskAcknowledgementRequired: false,
  trustRecord: {
    clawhubTrustDisposition: "clean" as const,
    clawhubTrustCheckedAt: "2026-11-12T00:00:00.000Z",
  },
};
const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
const expedia = { ref: "@expediagroup/expedia-openclaw", version: "1.0.4" };

/** Travel Copilot's shape: a minimal profile, registry and bundled dependencies, an automation. */
const travelCopilot = {
  schemaVersion: 1,
  agent: {
    id: "travel-copilot",
    name: "Travel Copilot",
    tools: { profile: "minimal", alsoAllow: ["web_fetch"] },
  },
  workspace: {
    bootstrapFiles: { "SOUL.md": { source: "workspace/SOUL.md" } },
    files: [{ path: "reference/airports.md", source: "workspace/reference/airports.md" }],
  },
  skills: [{ ref: "@steipete/goplaces", version: "1.0.0" }, { path: "skills/itinerary" }],
  plugins: [expedia, { path: "plugins/trip-notes" }],
  mcpServers: { docs: { url: "https://mcp.example.com/docs", transport: "streamable-http" } },
  automations: [
    {
      id: "fare-watch",
      schedule: { cron: "0 8 * * *", timezone: "UTC" },
      session: "main",
      message: "Check tracked fares.",
    },
  ],
};

async function writeTemplate(root: string, manifest: Record<string, unknown> = travelCopilot) {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      ...coordinate,
      name: coordinate.packageName,
      openclaw: { template: "CLAW.md" },
    }),
    "CLAW.md": `---\n${JSON.stringify(manifest)}\n---\n`,
    "BOOTSTRAP.md": "Ask where the traveller wants to go first.\n",
    "workspace/SOUL.md": "Plan practical trips.\n",
    "workspace/reference/airports.md": "LIS: Lisbon.\n",
    "workspace/CLAW.md": "The Template's own notes.\n",
    "skills/itinerary/SKILL.md":
      "---\nname: itinerary\ndescription: Build a day-by-day itinerary.\n---\nList each day.\n",
    "plugins/trip-notes/package.json": JSON.stringify({
      name: "trip-notes",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
    "plugins/trip-notes/openclaw.plugin.json": JSON.stringify({
      id: "trip-notes",
      configSchema: { type: "object", properties: {} },
    }),
    "plugins/trip-notes/index.js": "export default { id: 'trip-notes', register() {} };\n",
  };
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  const source = await readTemplateManifestFile(root);
  if (!source.ok) {
    throw new Error(JSON.stringify(source.diagnostics));
  }
  source.source = {
    ...source.source,
    kind: "package",
    name: coordinate.packageName,
    version: coordinate.version,
    integrityKind: "artifact",
  };
  return source;
}

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

/** One isolated Gateway request owner: real config, state, sessions and installers. */
async function withGateway(
  run: (gateway: {
    state: OpenClawTestState;
    config: () => OpenClawConfig;
    root: string;
    cron: { add: ReturnType<typeof vi.fn>; jobs: unknown[] };
    events: Array<{ stage: string; agentId: string }>;
    add: (params: Record<string, unknown>) => Promise<Parameters<RespondFn>>;
    workspace: (agentId: string) => string;
  }) => Promise<void>,
  entries: NonNullable<OpenClawConfig["agents"]>["entries"] = {},
  tools?: OpenClawConfig["tools"],
) {
  await withOpenClawTestState(
    {
      label: "template-chat-add",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
        OPENCLAW_CLAWHUB_URL: undefined,
        CLAWHUB_URL: undefined,
      },
    },
    async (state) => {
      let config: OpenClawConfig = {
        ...(tools ? { tools } : {}),
        gateway: { controlUi: { experimental: { templates: true } } },
        agents: {
          entries: { main: { workspace: state.path("existing-workspace") }, ...entries },
          ...(Object.keys(entries).length > 0 ? { ownership: "explicit" as const } : {}),
          defaults: { model: "ollama/test-model" },
        },
        // Installed but disabled: the condition that used to stop Add after admission.
        plugins: { entries: { "expedia-openclaw": { enabled: false } } },
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const unsubscribe = registerRuntimeConfigWriteListener((event) => {
        config = event.sourceConfig;
        setRuntimeConfigSnapshot(config);
        getRuntimeConfigWriteApplication(event)?.claim()?.settle("applied");
      });
      skills.preflight.mockResolvedValue({
        ok: true,
        action: "install",
        integrity: skillIntegrity,
      });
      skills.install.mockImplementation(
        async (params: { workspaceDir: string; slug: string; version: string }) => {
          const targetDir = path.join(params.workspaceDir, "skills", "goplaces");
          await fs.mkdir(targetDir, { recursive: true });
          await fs.writeFile(path.join(targetDir, "SKILL.md"), "---\nname: goplaces\n---\n");
          return { ok: true, slug: params.slug, version: params.version, targetDir };
        },
      );
      const cron = { add: vi.fn(), jobs: [] as unknown[] };
      const events: Array<{ stage: string; agentId: string }> = [];
      let request = 0;
      try {
        await run({
          state,
          config: () => config,
          root: state.path("registry-artifact"),
          cron,
          events,
          workspace: (agentId) => config.agents!.entries![agentId]!.workspace!,
          add: async (params) => {
            const respond = vi.fn<RespondFn>();
            await templatesAddHandlers["templates.add.apply"]!({
              req: { type: "req", id: `add-${++request}`, method: "templates.add.apply" },
              params,
              respond,
              client: {
                connId: "administrator",
                connect: { role: "operator", scopes: ["operator.admin"], client: { mode: "ui" } },
              },
              context: {
                getRuntimeConfig: () => config,
                broadcastToConnIds: (_event: string, payload: { stage: string; agentId: string }) =>
                  events.push({ stage: payload.stage, agentId: payload.agentId }),
                cron: {
                  add: cron.add,
                  list: async () => cron.jobs,
                  removeAgentJobsTransactional: async (_agentId: string, commit: () => unknown) =>
                    await commit(),
                },
              },
              isWebchatConnect: () => false,
            } as unknown as GatewayRequestHandlerOptions);
            expect(respond).toHaveBeenCalledOnce();
            return respond.mock.calls[0]!;
          },
        });
      } finally {
        unsubscribe();
      }
    },
  );
}

function deliver(source: Awaited<ReturnType<typeof writeTemplate>>) {
  resolveSource.mockImplementation(
    async (input: Parameters<typeof withResolvedClawHubSource>[0]) => ({
      value: await input.run(source, trust, async () => source),
      ...trust,
    }),
  );
}

const chatAdd = { mode: "chat", source: coordinate, agentId: "travel-copilot" };
const sessionKey = "agent:travel-copilot:main";

// Resolve the saved agent through the same profile/config layers used by tool construction.
it.each<{
  name: string;
  tools?: OpenClawConfig["tools"];
  operatorDeny?: string[];
  operatorAllow?: string[];
}>([
  {
    name: "Travel Copilot profile plus alsoAllow",
    tools: {
      profile: "minimal",
      alsoAllow: [
        "read",
        "write",
        "edit",
        "search_stays",
        "search_flights",
        "eg_travel_signup",
        "eg_travel_verify",
        "exec",
      ],
      fs: { workspaceOnly: true },
    },
  },
  { name: "explicit allow", tools: { allow: ["web_fetch"] } },
  { name: "no Template tools policy", tools: undefined },
  { name: "Template deny", tools: { profile: "minimal", deny: ["plugins"] } },
  { name: "operator deny", tools: undefined, operatorDeny: ["message"] },
  { name: "operator allow ceiling", tools: undefined, operatorAllow: ["read"] },
])(
  "makes setup tools effectively available without overriding explicit denies: $name",
  async ({ tools, ...scenario }) => {
    await withGateway(
      async (gateway) => {
        deliver(
          await writeTemplate(gateway.root, {
            schemaVersion: 1,
            agent: { id: "travel-copilot", name: "Travel Copilot", ...(tools ? { tools } : {}) },
          }),
        );
        const [ok, result] = await gateway.add(chatAdd);
        expect(ok, JSON.stringify(result)).toBe(true);
        const stored = (await readConfigFileSnapshot()).config;
        const effective = resolveEffectiveToolPolicy({ config: stored, agentId: "travel-copilot" });
        const policies = [
          mergeAlsoAllowPolicy(
            resolveToolProfilePolicy(effective.profile),
            effective.profileAlsoAllow,
          ),
          effective.globalPolicy,
          effective.agentPolicy,
        ];
        for (const tool of ["read", "automations", "plugins", "message"]) {
          const denied = tools?.deny?.includes(tool) || scenario.operatorDeny?.includes(tool);
          const excluded = scenario.operatorAllow && !scenario.operatorAllow.includes(tool);
          expect(isToolAllowedByPolicies(tool, policies), tool).toBe(!denied && !excluded);
        }
        if (tools?.fs) {
          expect(stored.agents!.entries!["travel-copilot"]!.tools?.fs).toEqual({
            workspaceOnly: true,
          });
          for (const tool of tools.alsoAllow ?? []) {
            expect(isToolAllowedByPolicies(tool, policies), tool).toBe(true);
          }
        }
      },
      {},
      {
        profile: "minimal",
        alsoAllow: ["web_fetch"],
        ...(scenario.operatorDeny ? { deny: scenario.operatorDeny } : {}),
        ...(scenario.operatorAllow ? { allow: scenario.operatorAllow, alsoAllow: undefined } : {}),
      },
    );
  },
);

it("creates the Template's agent without a plan, then hands the outcome to its first turn", async () => {
  await withGateway(async (gateway) => {
    const source = await writeTemplate(gateway.root);
    deliver(source);
    const atGreeting: { skill?: boolean; mcp?: boolean; pending?: boolean } = {};
    greeting.mockImplementation(async (_options, agentId: string) => {
      atGreeting.skill = await exists(
        path.join(gateway.workspace(agentId), "skills", "itinerary", "SKILL.md"),
      );
      const listed = await listConfiguredMcpServers();
      atGreeting.mcp = listed.ok && "docs" in listed.mcpServers;
      atGreeting.pending = (
        await readSessionEntryReadOnlyInWorker({ agentId, sessionKey })
      )?.initializationPending;
    });

    const [ok, result] = await gateway.add(chatAdd);

    expect(ok, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({ agentId: "travel-copilot", status: "complete", sessionKey });
    const stored = (await readConfigFileSnapshot()).config;
    const agent = stored.agents!.entries!["travel-copilot"]!;
    expect(agent.name).toBe("Travel Copilot");
    // The Template's minimal profile omitted all three.
    expect(agent.tools?.allow).toEqual(
      expect.arrayContaining(["web_fetch", "automations", "plugins", "message"]),
    );

    const workspace = agent.workspace!;
    expect(await fs.readFile(path.join(workspace, "SOUL.md"), "utf8")).toBe(
      "Plan practical trips.\n",
    );
    expect(await fs.readFile(path.join(workspace, "reference", "airports.md"), "utf8")).toBe(
      "LIS: Lisbon.\n",
    );
    expect(await fs.readFile(path.join(workspace, "BOOTSTRAP.md"), "utf8")).toBe(
      "Ask where the traveller wants to go first.\n",
    );
    expect(await fs.readFile(path.join(workspace, "CLAW.md"))).toEqual(
      await fs.readFile(path.join(gateway.root, "CLAW.md")),
    );

    // Both skills, without a question: the bundled one through the real installer.
    expect(
      await fs.readFile(path.join(workspace, "skills", "itinerary", "SKILL.md"), "utf8"),
    ).toContain("Build a day-by-day itinerary.");
    expect(skills.install).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: workspace,
        slug: "@steipete/goplaces",
        version: "1.0.0",
      }),
    );
    expect(await exists(path.join(workspace, "skills", "goplaces", "SKILL.md"))).toBe(true);

    const plugins = await readPersistedInstalledPluginIndexInstallRecordsAsync({
      env: gateway.state.env,
    });
    expect(plugins?.["trip-notes"]).toBeTruthy();
    const listed = await listConfiguredMcpServers();
    expect(listed.ok && listed.mcpServers.docs).toMatchObject({
      url: "https://mcp.example.com/docs",
    });

    // Left to the conversation: no automation, and the referenced plugin is untouched.
    expect(gateway.cron.add).not.toHaveBeenCalled();
    for (const call of [...Object.values(registry), ...Object.values(probe)]) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(Object.keys(plugins ?? {})).toEqual(["trip-notes"]);
    expect(stored.plugins?.entries?.["expedia-openclaw"]).toEqual({ enabled: false });

    // The first turn starts once, after creation, with the report and no installer cards.
    expect(greeting).toHaveBeenCalledOnce();
    expect(greeting.mock.calls[0]!.slice(1)).toEqual([
      "travel-copilot",
      sessionKey,
      "template",
      { failures: [], mcpServers: ["docs"] } satisfies TemplateSetupReport,
    ]);
    expect(atGreeting).toEqual({ skill: true, mcp: true, pending: undefined });
    expect(gateway.events).toEqual([
      { stage: "agent-admitted", agentId: "travel-copilot" },
      { stage: "agent-ready", agentId: "travel-copilot" },
    ]);
  });
});

it("keeps the agent and reports each dependency it could not set up", async () => {
  await withGateway(async (gateway) => {
    deliver(
      await writeTemplate(gateway.root, {
        ...travelCopilot,
        workspace: {
          ...travelCopilot.workspace,
          files: [{ path: "CLAW.md", source: "workspace/CLAW.md" }],
        },
        mcpServers: {
          ...travelCopilot.mcpServers,
          search: { url: "https://mcp.example.com/search", transport: "streamable-http" },
        },
      }),
    );
    skills.preflight.mockResolvedValue({
      ok: false,
      code: "skill_not_found",
      error: "Skill @steipete/goplaces@1.0.0 was not found on ClawHub.",
    });
    // An operator's own server already holds one declared name.
    await gateway.state.writeConfig({
      ...gateway.config(),
      mcp: { servers: { docs: { url: "https://internal.example.com/docs", transport: "sse" } } },
    });

    const [ok, result] = await gateway.add(chatAdd);

    expect(ok, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({ agentId: "travel-copilot", status: "complete" });
    const workspace = gateway.workspace("travel-copilot");
    expect(skills.install).not.toHaveBeenCalled();
    expect(await exists(path.join(workspace, "skills", "itinerary", "SKILL.md"))).toBe(true);
    expect(await fs.readFile(path.join(workspace, "CLAW.md"), "utf8")).toBe(
      "The Template's own notes.\n",
    );
    const listed = await listConfiguredMcpServers();
    expect(listed.ok && listed.mcpServers.docs).toMatchObject({
      url: "https://internal.example.com/docs",
    });
    const report = greeting.mock.calls[0]![4] as TemplateSetupReport;
    expect(report.mcpServers).toEqual(["search"]);
    expect(report.failures).toEqual([
      { kind: "manifest", name: "CLAW.md", reason: expect.stringContaining("was not copied") },
      {
        kind: "skill",
        name: "@steipete/goplaces",
        reason: "Skill @steipete/goplaces@1.0.0 was not found on ClawHub.",
      },
      { kind: "mcpServer", name: "docs", reason: expect.stringContaining("already exists") },
    ]);
  });
});

it.each(["fetch", "workspace"] as const)(
  "leaves no agent and no chat when the Template %s fails, and a repeated Add succeeds",
  async (failure) => {
    await withGateway(async (gateway) => {
      const source = await writeTemplate(gateway.root);
      if (failure === "fetch") {
        resolveSource.mockRejectedValue(
          new ClawHubSourceError(
            "clawhub_download_failed",
            "ClawHub could not deliver this Template.",
          ),
        );
      } else {
        deliver(source);
        workspaceWrite.fail = "reference/airports.md";
      }
      const before = gateway.config();
      const workspace = path.join(gateway.state.stateDir, "workspace-travel-copilot");

      const [ok, , error] = await gateway.add(chatAdd);

      expect(ok).toBe(false);
      expect(error?.message).toBe(
        failure === "fetch"
          ? "ClawHub could not deliver this Template."
          : "Could not add this Template. Review Gateway logs before retrying.",
      );
      // The agent and chat existed: the client was told, then both were removed.
      expect(gateway.events).toEqual([{ stage: "agent-admitted", agentId: "travel-copilot" }]);
      expect((await readConfigFileSnapshot()).config.agents?.entries).toEqual(
        before.agents?.entries,
      );
      expect(
        await readSessionEntryReadOnlyInWorker({ agentId: "travel-copilot", sessionKey }),
      ).toBeUndefined();
      expect(await exists(workspace)).toBe(false);
      expect(greeting).not.toHaveBeenCalled();

      deliver(source);
      workspaceWrite.fail = undefined;
      const [retried, result] = await gateway.add(chatAdd);
      expect(retried, JSON.stringify(result)).toBe(true);
      expect(result).toMatchObject({ agentId: "travel-copilot", status: "complete" });
      expect(await exists(path.join(workspace, "reference", "airports.md"))).toBe(true);
    });
  },
);

it("gives the new agent an unused id when the Template's id is taken", async () => {
  const existing = { name: "My own travel agent" };
  await withGateway(
    async (gateway) => {
      deliver(await writeTemplate(gateway.root));
      const taken = structuredClone(gateway.config().agents!.entries!["travel-copilot"]);

      const [ok, result, error] = await gateway.add(chatAdd);

      expect(ok, JSON.stringify(error)).toBe(true);
      expect(result).toMatchObject({
        agentId: "travel-copilot-2",
        status: "complete",
        sessionKey: "agent:travel-copilot-2:main",
      });
      const entries = (await readConfigFileSnapshot()).config.agents!.entries!;
      expect(entries["travel-copilot"]).toEqual(taken);
      expect(entries["travel-copilot-2"]).toMatchObject({ name: "Travel Copilot 2" });
      expect(gateway.events.map((event) => event.agentId)).toEqual([
        "travel-copilot-2",
        "travel-copilot-2",
      ]);
    },
    { "travel-copilot": existing },
  );
});
