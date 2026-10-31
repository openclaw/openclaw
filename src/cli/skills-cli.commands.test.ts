import { Chalk } from "chalk";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  resolveConfiguredAgentId,
  type AgentSelectionContext,
} from "../agents/agent-scope-config.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { ExitError } from "../runtime.js";
import type { SkillStatusEntry, SkillStatusReport } from "../skills/discovery/status.js";
import { registerSkillsCli } from "./skills-cli.js";
import { createCliTtyMock } from "./test-runtime-capture.js";

const { set: setTty, restore: restoreTty } = createCliTtyMock();
const mocks = await vi.hoisted(async () => {
  const { skill, runtimeFixture } = await import("./skills-cli.test-support.js");
  const report: SkillStatusReport = {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/workspace/skills",
    skills: [skill("calendar", { primaryEnv: "CALENDAR_API_KEY" })],
  };
  return {
    ...runtimeFixture(false, true),
    report,
    gateway: vi.fn(),
    config: vi.fn((_options?: unknown) => ({})),
    defaultAgent: vi.fn((_config: unknown, _context?: AgentSelectionContext) => "main"),
    inferredAgent: vi.fn((_config: unknown, _cwd: string): string | undefined => undefined),
    explicitAgent: vi.fn((_config: unknown, agent: string) => agent),
    workspace: vi.fn((_config: unknown, _agent: string) => "/tmp/workspace"),
    install: vi.fn(),
    sourceInstall: vi.fn(),
    update: vi.fn(),
    tracked: vi.fn(),
    target: vi.fn(),
    verify: vi.fn(),
    card: vi.fn(),
    status: vi.fn((_workspace: string, _options?: unknown) => report),
  };
});
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));
vi.mock("./one-shot-exit.js", () => ({
  exitCliAfterOutput: (runtime: typeof mocks.runtime, code: number) => runtime.exit(code),
}));
vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.gateway,
  isGatewayClientRequestError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayClientRequestError",
  isGatewayCredentialsRequiredError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayCredentialsRequiredError",
  isImplicitLocalGatewayTarget: async ({ config }: { config?: { gateway?: { mode?: string } } }) =>
    !process.env.OPENCLAW_GATEWAY_URL && config?.gateway?.mode !== "remote",
}));
vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  CONFIG_DIR: "/tmp/openclaw-config",
}));
// mock-isolation: Skill command fixtures own workspace selection and config without host state.
vi.mock("../config/config.js", async () => {
  const { createTestConfigReadMocks } = await import("../commands/test-runtime-config-helpers.js");
  return {
    ...createTestConfigReadMocks(mocks, "config"),
  };
});
// mock-isolation: Skill CLI fixtures own agent and workspace selection without host configuration.
vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  resolveAgentIdByWorkspacePath: mocks.inferredAgent,
  resolveConfiguredAgentId: mocks.explicitAgent,
  resolveDefaultAgentId: mocks.defaultAgent,
  resolveAgentWorkspaceDir: mocks.workspace,
}));
// mock-isolation: Command fixtures own registry results and never download or install real skills.
vi.mock("../skills/lifecycle/clawhub.js", () => ({
  installSkillFromClawHub: mocks.install,
  updateSkillsFromClawHub: mocks.update,
  readTrackedClawHubSkillSlugs: mocks.tracked,
  readVerifiedClawHubSkillSourceUrl: () => undefined,
  resolveClawHubSkillVerificationTarget: mocks.target,
  verifySkillWithClawHub: mocks.verify,
}));
vi.mock("../infra/clawhub-skills.js", () => ({
  CLAWHUB_SKILLS_SH_REF_PREFIX: "skills-sh:",
  CLAWHUB_SKILLS_SH_TRUST_LABEL: "Not scanned by ClawHub",
  CLAWHUB_SKILLS_SH_TRUST_STATE: "not-scanned-by-clawhub",
  fetchClawHubSkillCard: mocks.card,
}));
// mock-isolation: Exercise command routing without filesystem or network skill installation.
vi.mock("../skills/lifecycle/source-install.js", () => ({
  installSkillFromSource: mocks.sourceInstall,
  isSkillSourceInstallSpec: (raw: string) =>
    ["git:", "./", "../", "~/", "/"].some((prefix) => raw.startsWith(prefix)),
}));
vi.mock("../skills/discovery/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/discovery/status.js")>()),
  prepareWorkspaceSkillStatus: async (workspace: string, options?: unknown) => ({
    report: mocks.status(workspace, options),
    files: [],
  }),
}));
const { runtime, stdout, errors } = mocks;

function transportError(code = 1006) {
  return new GatewayTransportError({
    kind: "closed",
    code,
    reason: "unavailable",
    message: `gateway closed (${code}): unavailable`,
    connectionDetails: { url: "ws://127.0.0.1:18789", urlSource: "local loopback", message: "" },
  });
}
function primeVerification(overrides: Record<string, unknown> = {}) {
  mocks.verify.mockResolvedValue({
    ok: true,
    value: {
      ok: true,
      decision: "pass",
      ...overrides,
    },
  });
}
function run(input: string | string[]) {
  const argv = typeof input === "string" ? input.split(" ") : input;
  const program = new Command().exitOverride();
  registerSkillsCli(program);
  return program.parseAsync(["skills", ...argv], { from: "user" });
}

async function expectFailure(argv: string | string[], message?: string) {
  await expect(run(argv)).rejects.toThrow("__exit__:1");
  if (message) {
    expect(errors).toContain(message);
  }
}
function expectUnused(...functions: unknown[]) {
  for (const fn of functions) {
    expect(fn).not.toHaveBeenCalled();
  }
}
function expectOptions(fn: unknown, options: Record<string, unknown>) {
  expect(fn).toHaveBeenCalledWith(expect.objectContaining(options));
}
function setUnreadySkill(overrides: Partial<SkillStatusEntry>) {
  const readiness = { eligible: false, modelVisible: false, commandVisible: false };
  const report = {
    ...mocks.report,
    skills: mocks.report.skills.map((skill) => ({ ...skill, ...readiness, ...overrides })),
  };
  mocks.status.mockReturnValue(report);
  return report;
}

function installedCalendar(targetDir = "/tmp/workspace/skills/calendar") {
  return { ok: true, slug: "calendar", version: "1.2.3", targetDir };
}

describe("skills cli commands", () => {
  it.each([
    ["install skills-sh/invalid", "Invalid skills.sh skill reference: skills-sh/invalid", false],
    ["update", "Provide a skill slug or use --all.", false],
    ["verify weather --global --agent main", "Use either --global or --agent, not both.", true],
  ])("preserves terminal failures for %s", async (argv, message, json) => {
    const exit = new ExitError(1);
    await runtime.exit.withImplementation(
      () => {
        throw exit;
      },
      () => expect(run(argv)).rejects.toBe(exit),
    );
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(errors).toEqual(json ? [] : [message]);
    expect(stdout).toEqual(
      json ? [JSON.stringify({ ok: false, error: { type: "cli_error", message } }, null, 2)] : [],
    );
    expectUnused(mocks.install, mocks.update, mocks.verify, mocks.target);
  });

  beforeEach(() => {
    stdout.length = 0;
    errors.length = 0;
    for (const mock of Object.values(mocks)) {
      if (vi.isMockFunction(mock)) {
        mock.mockReset();
      }
    }
    Object.values(runtime).forEach((mock) => mock.mockClear());
    mocks.gateway.mockRejectedValue(transportError());
    mocks.install.mockResolvedValue({ ok: false, error: "install disabled in test" });
    mocks.sourceInstall.mockRejectedValue(new Error("source install disabled in test"));
    mocks.update.mockResolvedValue([]);
    mocks.tracked.mockResolvedValue([]);
    mocks.target.mockResolvedValue({ ok: true, slug: "agentreceipt", resolution: {} });
    primeVerification();
  });
  afterEach(() => {
    restoreTty();
    vi.unstubAllEnvs();
  });

  it("installs a versioned ClawHub skill globally with interactive confirmation", async () => {
    setTty(true);
    mocks.gateway.mockResolvedValue(mocks.report);
    mocks.install.mockResolvedValue(installedCalendar("/tmp/openclaw-config/skills/calendar"));
    await run("install calendar --version 1.2.3 --global --force-install");
    expectOptions(mocks.install, {
      workspaceDir: "/tmp/openclaw-config",
      slug: "calendar",
      version: "1.2.3",
      force: false,
      forceInstall: true,
      confirmInstall: expect.any(Function),
      onInstallPolicyWarning: expect.any(Function),
    });
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "Installed calendar@1.2.3 -> /tmp/openclaw-config/skills/calendar",
    );
    expectOptions(mocks.gateway, {
      method: "skills.status",
      params: { agentId: "main", refresh: true },
    });
  });
  it.each([
    [
      "skills-sh:openclaw/skills/weather --version 1.2.3",
      "--version is not supported for skills-sh references.",
    ],
    ["git:owner/tools --version 1.2.3", "--version is only supported for ClawHub skill installs."],
    [
      "./local-skill --force-install",
      "--force-install is only supported for ClawHub skill installs.",
    ],
  ])("rejects invalid install arguments: %s", async (args, error) => {
    await expectFailure(`install ${args}`, error);
    expectUnused(mocks.install, mocks.sourceInstall);
  });
  it("installs a source under --as with noninteractive policy acknowledgement", async () => {
    setTty(false);
    mocks.sourceInstall.mockResolvedValue({
      slug: "tools",
      source: "git",
      targetDir: "/tmp/workspace/skills/tools",
    });
    await run("install git:owner/tools --as tools --acknowledge-install-policy-warning");
    expectOptions(mocks.sourceInstall, {
      workspaceDir: "/tmp/workspace",
      spec: "git:owner/tools",
      slug: "tools",
      force: false,
      onInstallPolicyWarning: expect.any(Function),
    });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "Installed tools from git -> /tmp/workspace/skills/tools",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Skill files changed, but local Gateway refresh failed:"),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });
  it("keeps a local install from refreshing a configured remote Gateway", async () => {
    mocks.config.mockReturnValue({ gateway: { mode: "remote" } });
    mocks.install.mockResolvedValue(installedCalendar());
    await run("install calendar");
    expect(mocks.gateway).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "Installed calendar@1.2.3 -> /tmp/workspace/skills/calendar",
    );
  });
  it("prints a blocked install failure when no trust warning was emitted", async () => {
    const error =
      'ClawHub blocked artifact download for "calendar@1.2.3"; install was not started.';
    mocks.install.mockResolvedValue({ ok: false, code: "clawhub_download_blocked", error });
    await expectFailure("install calendar", error);
  });
  it("updates tracked skills with the requested force options", async () => {
    mocks.tracked.mockResolvedValue(["calendar"]);
    mocks.update.mockResolvedValue([
      { ...installedCalendar(), previousVersion: "1.2.2", changed: true },
    ]);
    await run("update --all --force --force-install");
    expectOptions(mocks.update, {
      workspaceDir: "/tmp/workspace",
      force: true,
      forceInstall: true,
    });
    expect(runtime.log).toHaveBeenCalledWith("Updated calendar: 1.2.2 -> 1.2.3");
    expect(errors).toEqual([]);
  });
  it("does not bootstrap configured skills during update all", async () => {
    mocks.config.mockReturnValueOnce({ agents: { defaults: { skills: ["apple-notes"] } } });
    await run("update --all");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("No tracked ClawHub skills to update.");
    expect(errors).toEqual([]);
  });
  it.each([
    [
      "force_required",
      "Local skill files changed.",
      "Local skill files changed. Re-run with --force to update it anyway.",
    ],
    [
      undefined,
      "blocked by install policy: calendar is not approved",
      "blocked by install policy: calendar is not approved",
    ],
  ])("exits nonzero for update failure %s", async (code, error, expected) => {
    mocks.tracked.mockResolvedValue(["calendar"]);
    mocks.update.mockResolvedValue([{ ok: false, code, error }]);
    await expectFailure("update calendar", expected);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it.each([
    [{ available: false }, "Skill Card is not available."],
    [null, "ClawHub verification response did not include a Skill Card URL."],
    [{ available: true }, "ClawHub verification response did not include a Skill Card URL."],
  ])("rejects verified Skill Card metadata %s", async (card, error) => {
    primeVerification({ card });
    await expectFailure("verify agentreceipt --card", error);
    expectUnused(mocks.card, runtime.writeJson);
  });
  it.each([
    { label: "unknown decision", ok: true, decision: "quarantined" },
    { label: "non-boolean ok", ok: "false", decision: "pass" },
  ])("fails closed for verification envelopes with $label", async ({ ok, decision }) => {
    primeVerification({ ok, decision });
    await expectFailure("verify agentreceipt");
    expect(JSON.parse(stdout.at(-1) ?? "{}")).toMatchObject({ ok, decision });
    expect(errors).toEqual([]);
  });
  it.each([
    { label: "default", argv: ["--json"] },
    { label: "check", argv: ["check", "--json"] },
  ])("writes $label JSON from the selected workspace to stdout", async ({ label, argv }) => {
    mocks.inferredAgent.mockReturnValue("main");
    mocks.workspace.mockImplementation((_config, id) => `/tmp/workspace-${id}`);
    await run(argv);
    expect(mocks.status).toHaveBeenCalledWith(
      "/tmp/workspace-main",
      expect.objectContaining({ config: {} }),
    );
    expect(runtime.writeStdout).toHaveBeenCalledOnce();
    expectUnused(mocks.explicitAgent, runtime.writeJson, runtime.log, runtime.exit);
    expect(errors).toEqual([]);
    const payload = JSON.parse(stdout[0] ?? "{}");
    if (label === "check") {
      expect(payload.summary).toMatchObject({ total: 1, eligible: 1 });
    } else {
      expect(payload.skills).toHaveLength(1);
      expect(payload.skills[0].name).toBe("calendar");
    }
  });
  it.each([false, true])("exits nonzero for missing skill info (JSON: %s)", async (json) => {
    vi.stubEnv("OPENCLAW_PROFILE", "");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
    await expectFailure(["info", "missing-skill", ...(json ? ["--json"] : [])]);
    const error = { type: "cli_error", message: 'Skill "missing-skill" not found.' };
    expect(stdout).toEqual([
      json
        ? JSON.stringify({ ok: false, error, skill: "missing-skill" }, null, 2)
        : 'Skill "missing-skill" not found. Run `openclaw skills list` to see available skills.\n\nTip: use `openclaw skills search`, `openclaw skills install`, and `openclaw skills update` for ClawHub-backed skills.',
    ]);
    expect(errors).toEqual([]);
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("renders sanitized colored skill names with normalized and fallback emoji", async () => {
    setTty(false);
    vi.stubEnv("TERM", "dumb");
    const baseSkill = mocks.report.skills[0]!;
    mocks.gateway.mockResolvedValue({
      ...mocks.report,
      skills: [
        { ...baseSkill, name: "\u001b[31mcalendar\u001b[0m\u009f", emoji: "🎛\uFE0E" },
        { ...baseSkill, name: "plain", emoji: undefined },
      ],
    });
    using _ = vi.spyOn(theme, "command").mockImplementation(new Chalk({ level: 1 }).cyan);

    await run("list");
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain("🎛\uFE0F \u001b[36mcalendar\u001b[39m");
    expect(stdout[0]).toContain("\u001b[36mplain\u001b[39m");
    expect(stdout[0]).not.toContain("\u009f");
    expect(stdout[0]).not.toContain("📦");
  });
  it.each([
    ["weather", "skills.entries.weather.apiKey"],
    ["acme.weather", `'skills.entries["acme.weather"].apiKey'`],
  ])("prints a copyable API-key setup path for %s", async (skillKey, configPath) => {
    vi.stubEnv("OPENCLAW_PROFILE", "");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
    setUnreadySkill({
      skillKey,
      missing: { ...mocks.report.skills[0]!.missing, env: ["CALENDAR_API_KEY"] },
    });
    await run("info calendar");
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain(`Save via CLI: openclaw config set ${configPath} YOUR_KEY`);
  });
  it("renders one status per alternative group", async () => {
    const report = setUnreadySkill({
      requirements: {
        bins: ["present-bin", "missing-bin"],
        anyBins: ["node", "missing-runtime"],
        env: ["PRESENT_ENV", "MISSING_ENV"],
        config: ["present.config", "missing.config"],
        os: ["linux", "darwin"],
      },
      missing: {
        bins: ["missing-bin"],
        anyBins: [],
        env: ["MISSING_ENV"],
        config: ["missing.config"],
        os: [],
      },
    });
    await run("info calendar");
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain("Any binaries: ✓ (any of: node, missing-runtime)");
    expect(stdout[0]).toContain(`OS: ✓ (linux, darwin)`);
    expect(stdout[0]).toContain("Binaries: ✓ present-bin, ✗ missing-bin");
    expect(stdout[0]).toContain("Environment: ✓ PRESENT_ENV, ✗ MISSING_ENV");
    expect(stdout[0]).toContain("Config: ✓ present.config, ✗ missing.config");
    await run("info calendar --json");
    expect(stdout[1]).toBe(JSON.stringify(report.skills[0], null, 2));
  });

  it("uses Gateway skills.status instead of local status when reachable", async () => {
    mocks.gateway.mockResolvedValue({
      ...mocks.report,
      agentId: "writer",
      workspaceDir: "/gateway/workspace-writer",
    });
    await run("check --agent writer --json");
    expectOptions(mocks.gateway, {
      method: "skills.status",
      params: { agentId: "writer" },
    });
    expect(mocks.status).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.at(-1) ?? "{}")).toMatchObject({
      workspaceDir: "/gateway/workspace-writer",
      eligible: ["calendar"],
      missingRequirements: [],
    });
  });
  it.each([
    [new Error("Gateway not reachable: ws://127.0.0.1:9"), false, true],
    [
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: 'invalid skills.status params: unknown agent id "retired"',
      }),
      false,
      false,
    ],
    [transportError(1008), true, false],
  ] as const)(
    "never replaces failed Gateway data with local skills: %s",
    async (error, root, remote) => {
      if (remote) {
        mocks.config.mockReturnValue({
          gateway: { mode: "remote", remote: { url: "ws://127.0.0.1:9" } },
        });
      }
      mocks.gateway.mockRejectedValue(error);
      const command = run("list --json");
      if (root) {
        await expect(command).rejects.toBe(error);
        expect(errors).toEqual([]);
      } else {
        await expect(command).rejects.toThrow("__exit__:1");
        expect(errors).toEqual([error.message]);
      }
      expect(stdout).toEqual([]);
      expect(mocks.status).not.toHaveBeenCalled();
    },
  );
  it("rejects an unknown agent before resolving a skills workspace", async () => {
    mocks.explicitAgent.mockImplementation((_config, agent) =>
      resolveConfiguredAgentId({ agents: { entries: { main: {}, writer: {} } } }, agent),
    );
    await expectFailure("list --agent nope-agent");
    expect(errors).toEqual([
      'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
    ]);
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
  it("canonicalizes a mixed-case --agent before selecting the configured agent", async () => {
    mocks.explicitAgent.mockImplementation((_config, agent) =>
      resolveConfiguredAgentId({ agents: { entries: { main: {}, writer: {} } } }, agent),
    );
    mocks.gateway.mockResolvedValue(mocks.report);
    await run(["check", "--agent", " Writer ", "--json"]);
    expect(errors).toEqual([]);
    expect(mocks.explicitAgent).toHaveBeenCalledWith({}, "writer");
    expect(mocks.gateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "skills.status", params: { agentId: "writer" } }),
    );
  });
  it("redacts secrets from rendered skills CLI errors", async () => {
    const secret = "sk-abcdefghijklmnopqrstuv";
    mocks.defaultAgent.mockImplementationOnce(() => {
      throw new Error(`Skill lookup failed with token=${secret}`);
    });
    await expectFailure("list");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Skill lookup failed");
    expect(errors[0]).not.toContain(secret);
  });
});
