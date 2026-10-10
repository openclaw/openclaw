import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import {
  resolveConfiguredAgentId,
  type AgentSelectionContext,
} from "../agents/agent-scope-config.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import type { SkillStatusReport } from "../skills/discovery/status.js";
import type * as SourceInstall from "../skills/lifecycle/source-install.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { registerSkillsCli } from "./skills-cli.js";

const originalTty = [process.stdin, process.stdout].map((stream) =>
  Object.getOwnPropertyDescriptor(stream, "isTTY"),
);
function setTty(value: boolean) {
  for (const stream of [process.stdin, process.stdout]) {
    Object.defineProperty(stream, "isTTY", { value, configurable: true });
  }
}
const mocks = vi.hoisted(() => {
  const stdout: string[] = [];
  const errors: string[] = [];
  const report: SkillStatusReport = {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/workspace/skills",
    skills: [
      {
        name: "calendar",
        description: "Calendar helpers",
        source: "bundled",
        bundled: false,
        filePath: "/tmp/workspace/skills/calendar/SKILL.md",
        baseDir: "/tmp/workspace/skills/calendar",
        skillKey: "calendar",
        emoji: "📅",
        homepage: "https://example.com/calendar",
        always: false,
        disabled: false,
        blockedByAllowlist: false,
        blockedByAgentFilter: false,
        eligible: true,
        platformIncompatible: false,
        modelVisible: true,
        userInvocable: true,
        commandVisible: true,
        primaryEnv: "CALENDAR_API_KEY",
        requirements: { bins: [], anyBins: [], env: ["CALENDAR_API_KEY"], config: [], os: [] },
        missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
        configChecks: [],
        install: [],
      },
    ],
  };
  return {
    stdout,
    errors,
    report,
    runtime: {
      log: vi.fn(),
      error: vi.fn((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      }),
      writeStdout: vi.fn((value: string) => {
        stdout.push(value.endsWith("\n") ? value.slice(0, -1) : value);
      }),
      writeJson: vi.fn((value: unknown, space = 2) => {
        stdout.push(JSON.stringify(value, null, space > 0 ? space : undefined));
      }),
      exit: vi.fn((code: number) => {
        if (code !== 0) {
          throw new Error(`__exit__:${code}`);
        }
      }),
    },
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
    sourceUrl: vi.fn(),
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
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.config,
  loadConfig: mocks.config,
}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentIdByWorkspacePath: mocks.inferredAgent,
  resolveConfiguredAgentId: mocks.explicitAgent,
  resolveDefaultAgentId: mocks.defaultAgent,
  resolveAgentWorkspaceDir: mocks.workspace,
}));
vi.mock("../skills/lifecycle/clawhub.js", () => ({
  installSkillFromClawHub: mocks.install,
  updateSkillsFromClawHub: mocks.update,
  readTrackedClawHubSkillSlugs: mocks.tracked,
  readVerifiedClawHubSkillSourceUrl: mocks.sourceUrl,
  resolveClawHubSkillVerificationTarget: mocks.target,
  verifySkillWithClawHub: mocks.verify,
}));
vi.mock("../infra/clawhub-skills.js", () => ({
  CLAWHUB_SKILLS_SH_REF_PREFIX: "skills-sh:",
  CLAWHUB_SKILLS_SH_TRUST_LABEL: "Not scanned by ClawHub",
  CLAWHUB_SKILLS_SH_TRUST_STATE: "not-scanned-by-clawhub",
  fetchClawHubSkillCard: mocks.card,
}));
vi.mock("../skills/lifecycle/source-install.js", () => ({
  installSkillFromSource: mocks.sourceInstall,
  isSkillSourceInstallSpec: (raw: string) =>
    raw.startsWith("git:") ||
    raw.startsWith("./") ||
    raw.startsWith("../") ||
    raw.startsWith("~/") ||
    raw.startsWith("/"),
}));
vi.mock("../skills/discovery/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/discovery/status.js")>()),
  prepareWorkspaceSkillStatus: async (workspace: string, options?: unknown) => ({
    report: mocks.status(workspace, options),
    files: [],
  }),
}));
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
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      skill: { slug: "agentreceipt" },
      publisher: null,
      version: { version: "1.2.3" },
      card: { available: true },
      artifact: null,
      provenance: null,
      security: { status: "clean" },
      signature: { status: "unsigned" },
      ...overrides,
    },
  });
}
async function runCommand(argv: string[]) {
  const program = new Command().exitOverride();
  registerSkillsCli(program);
  try {
    await program.parseAsync(["skills", ...argv], { from: "user" });
  } catch (error) {
    if (!(error instanceof Error && error.message === "__exit__:0")) {
      throw error;
    }
  }
}

describe("skills cli commands", () => {
  beforeEach(() => {
    mocks.stdout.length = 0;
    mocks.errors.length = 0;
    for (const mock of [
      mocks.gateway,
      mocks.config,
      mocks.defaultAgent,
      mocks.inferredAgent,
      mocks.explicitAgent,
      mocks.workspace,
      mocks.install,
      mocks.sourceInstall,
      mocks.update,
      mocks.tracked,
      mocks.sourceUrl,
      mocks.target,
      mocks.verify,
      mocks.card,
      mocks.status,
    ]) {
      mock.mockReset();
    }
    for (const mock of Object.values(mocks.runtime)) {
      mock.mockClear();
    }
    mocks.gateway.mockRejectedValue(transportError());
    mocks.config.mockReturnValue({});
    mocks.defaultAgent.mockReturnValue("main");
    mocks.inferredAgent.mockReturnValue(undefined);
    mocks.explicitAgent.mockImplementation((_config, agent) => agent);
    mocks.workspace.mockReturnValue("/tmp/workspace");
    mocks.install.mockResolvedValue({ ok: false, error: "install disabled in test" });
    mocks.sourceInstall.mockResolvedValue({ ok: false, error: "source install disabled in test" });
    mocks.update.mockResolvedValue([]);
    mocks.tracked.mockResolvedValue([]);
    mocks.sourceUrl.mockReturnValue(undefined);
    mocks.target.mockResolvedValue({
      ok: true,
      slug: "agentreceipt",
      baseUrl: "https://private.example.com/clawhub",
      version: "1.2.3",
      tag: undefined,
      resolution: {
        source: "installed",
        selector: "installed-version",
        registry: "https://private.example.com/clawhub",
        skillDir: "/tmp/workspace/skills/agentreceipt",
        installedVersion: "1.2.3",
      },
    });
    primeVerification();
    mocks.card.mockResolvedValue("# Agent Receipt\n\nGenerated by ClawHub.\n");
    mocks.status.mockReturnValue(mocks.report);
  });
  afterEach(() => {
    [process.stdin, process.stdout].forEach((stream, index) => {
      const descriptor = originalTty[index];
      if (descriptor) {
        Object.defineProperty(stream, "isTTY", descriptor);
      } else {
        Reflect.deleteProperty(stream, "isTTY");
      }
    });
    vi.unstubAllEnvs();
  });

  it("installs a versioned ClawHub skill globally with interactive confirmation", async () => {
    setTty(true);
    mocks.install.mockResolvedValue({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/openclaw-config/skills/calendar",
    });
    await runCommand(["install", "calendar", "--version", "1.2.3", "--global", "--force-install"]);
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/openclaw-config",
        slug: "calendar",
        version: "1.2.3",
        force: false,
        forceInstall: true,
        config: {},
        confirmInstall: expect.any(Function),
        onInstallPolicyWarning: expect.any(Function),
        logger: expect.any(Object),
      }),
    );
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(mocks.runtime.log).toHaveBeenCalledWith(
      "Installed calendar@1.2.3 -> /tmp/openclaw-config/skills/calendar",
    );
  });
  it.each([
    {
      args: ["skills-sh:openclaw/skills/weather", "--version", "1.2.3"],
      error: "--version is not supported for skills-sh references.",
    },
    {
      args: ["skills-sh/openclaw/skills/weather"],
      error: "Invalid skills.sh skill reference: skills-sh/openclaw/skills/weather",
    },
    {
      args: ["git:owner/tools", "--version", "1.2.3"],
      error: "--version is only supported for ClawHub skill installs.",
    },
    {
      args: ["./local-skill", "--force-install"],
      error: "--force-install is only supported for ClawHub skill installs.",
    },
  ])("rejects invalid install arguments: $args", async ({ args, error }) => {
    await expect(runCommand(["install", ...args])).rejects.toThrow("__exit__:1");
    expect(mocks.errors).toContain(error);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.sourceInstall).not.toHaveBeenCalled();
  });
  it("fails a source install with --as when its description cannot be parsed", async () => {
    await withTestDir({ prefix: "openclaw-skills-cli-invalid-source-" }, async (root) => {
      const sourceDir = path.join(root, "source");
      const workspaceDir = path.join(root, "workspace");
      await fs.mkdir(sourceDir);
      await fs.writeFile(
        path.join(sourceDir, "SKILL.md"),
        "name: invisible\ndescription: unfenced\n\n---\n",
      );
      const { installSkillFromSource } = await vi.importActual<typeof SourceInstall>(
        "../skills/lifecycle/source-install.js",
      );
      mocks.sourceInstall.mockImplementation(installSkillFromSource);
      mocks.workspace.mockReturnValue(workspaceDir);

      await expect(runCommand(["install", sourceDir, "--as", "invisible"])).rejects.toThrow(
        "__exit__:1",
      );
      expect(mocks.errors.join("\n")).toContain("description is required");
      expect(mocks.runtime.log.mock.calls.flat().join("\n")).not.toContain("Installed");
      await expect(fs.access(path.join(workspaceDir, "skills", "invisible"))).rejects.toThrow();
    });
  });

  it("installs a source under --as with noninteractive policy acknowledgement", async () => {
    setTty(false);
    mocks.sourceInstall.mockResolvedValue({
      ok: true,
      slug: "tools",
      source: "git",
      targetDir: "/tmp/workspace/skills/tools",
    });
    await runCommand([
      "install",
      "git:owner/tools",
      "--as",
      "tools",
      "--acknowledge-install-policy-warning",
    ]);
    expect(mocks.sourceInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/workspace",
        spec: "git:owner/tools",
        slug: "tools",
        force: false,
        config: {},
        logger: expect.any(Object),
        onInstallPolicyWarning: expect.any(Function),
      }),
    );
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.runtime.log).toHaveBeenCalledWith(
      "Installed tools from git -> /tmp/workspace/skills/tools",
    );
  });
  it("prints a blocked install failure when no trust warning was emitted", async () => {
    const error =
      'ClawHub blocked artifact download for "calendar@1.2.3"; install was not started.';
    mocks.install.mockResolvedValue({ ok: false, code: "clawhub_download_blocked", error });
    await expect(runCommand(["install", "calendar"])).rejects.toThrow("__exit__:1");
    expect(mocks.errors).toContain(error);
  });
  it("updates tracked skills with the requested force options", async () => {
    mocks.tracked.mockResolvedValue(["calendar"]);
    mocks.update.mockResolvedValue([
      {
        ok: true,
        slug: "calendar",
        previousVersion: "1.2.2",
        version: "1.2.3",
        changed: true,
        targetDir: "/tmp/workspace/skills/calendar",
      },
    ]);
    await runCommand(["update", "--all", "--force", "--force-install"]);
    expect(mocks.tracked).toHaveBeenCalledWith("/tmp/workspace");
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/workspace",
        slug: undefined,
        force: true,
        forceInstall: true,
        config: {},
        logger: expect.any(Object),
      }),
    );
    expect(mocks.runtime.log).toHaveBeenCalledWith("Updated calendar: 1.2.2 -> 1.2.3");
    expect(mocks.errors).toEqual([]);
  });
  it("does not bootstrap configured skills during update all", async () => {
    mocks.config.mockReturnValueOnce({ agents: { defaults: { skills: ["apple-notes"] } } });
    await runCommand(["update", "--all"]);
    expect(mocks.tracked).toHaveBeenCalledWith("/tmp/workspace");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.runtime.log).toHaveBeenCalledWith("No tracked ClawHub skills to update.");
    expect(mocks.errors).toEqual([]);
  });
  it.each([
    {
      code: "force_required",
      error: "Local skill files changed.",
      expected: "Local skill files changed. Re-run with --force to update it anyway.",
    },
    {
      code: undefined,
      error: "blocked by install policy: calendar is not approved",
      expected: "blocked by install policy: calendar is not approved",
    },
  ])("exits nonzero for update failure $code", async ({ code, error, expected }) => {
    mocks.tracked.mockResolvedValue(["calendar"]);
    mocks.update.mockResolvedValue([{ ok: false, code, error }]);
    await expect(runCommand(["update", "calendar"])).rejects.toThrow("__exit__:1");
    expect(mocks.errors).toContain(expected);
    expect(mocks.runtime.log).not.toHaveBeenCalled();
  });

  it.each([
    { label: "unavailable", card: { available: false }, error: "Skill Card is not available." },
    {
      label: "missing",
      card: null,
      error: "ClawHub verification response did not include a Skill Card URL.",
    },
    {
      label: "missing URL",
      card: { available: true },
      error: "ClawHub verification response did not include a Skill Card URL.",
    },
  ])("rejects $label verified Skill Card metadata", async ({ card, error }) => {
    primeVerification({ card });
    await expect(runCommand(["verify", "agentreceipt", "--card"])).rejects.toThrow("__exit__:1");
    expect(mocks.errors).toContain(error);
    expect(mocks.card).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });
  it.each([
    { label: "unknown decision", ok: true, decision: "quarantined" },
    { label: "non-boolean ok", ok: "false", decision: "pass" },
  ])("fails closed for verification envelopes with $label", async ({ ok, decision }) => {
    primeVerification({ ok, decision });
    await expect(runCommand(["verify", "agentreceipt"])).rejects.toThrow("__exit__:1");
    expect(JSON.parse(mocks.stdout.at(-1) ?? "{}")).toMatchObject({ ok, decision });
    expect(mocks.errors).toEqual([]);
  });
  it("returns JSON when verify workspace selection fails", async () => {
    mocks.runtime.exit.mockImplementationOnce(() => undefined);
    await runCommand(["verify", "agentreceipt", "--global", "--agent", "main"]);
    expect(JSON.parse(mocks.stdout.at(-1) ?? "{}")).toEqual({
      ok: false,
      error: { type: "cli_error", message: "Use either --global or --agent, not both." },
    });
    expect(mocks.errors).toEqual([]);
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.target).not.toHaveBeenCalled();
  });

  it.each([
    { label: "default", argv: ["--json"] },
    { label: "check", argv: ["check", "--json"] },
  ])("writes $label JSON from the selected workspace to stdout", async ({ label, argv }) => {
    mocks.inferredAgent.mockReturnValue("main");
    mocks.workspace.mockImplementation((_config, id) => `/tmp/workspace-${id}`);
    await runCommand(argv);
    expect(mocks.status).toHaveBeenCalledWith(
      "/tmp/workspace-main",
      expect.objectContaining({ config: {} }),
    );
    expect(mocks.explicitAgent).not.toHaveBeenCalled();
    expect(mocks.runtime.writeStdout).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    expect(mocks.runtime.log).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
    expect(mocks.errors).toEqual([]);
    const payload = JSON.parse(mocks.stdout[0] ?? "{}");
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
    await expect(
      runCommand(["info", "missing-skill", ...(json ? ["--json"] : [])]),
    ).rejects.toThrow("__exit__:1");
    expect(mocks.stdout).toEqual([
      json
        ? JSON.stringify(
            {
              ok: false,
              error: { type: "cli_error", message: 'Skill "missing-skill" not found.' },
              skill: "missing-skill",
            },
            null,
            2,
          )
        : 'Skill "missing-skill" not found. Run `openclaw skills list` to see available skills.\n\nTip: use `openclaw skills search`, `openclaw skills install`, and `openclaw skills update` for ClawHub-backed skills.',
    ]);
    expect(mocks.errors).toEqual([]);
    expect(mocks.runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it.each([
    ["weather", "skills.entries.weather.apiKey"],
    ["acme.weather", `'skills.entries["acme.weather"].apiKey'`],
  ])("prints a copyable API-key setup path for %s", async (skillKey, configPath) => {
    vi.stubEnv("OPENCLAW_PROFILE", "");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
    mocks.status.mockReturnValue({
      ...mocks.report,
      skills: mocks.report.skills.map((skill) => ({
        ...skill,
        skillKey,
        eligible: false,
        modelVisible: false,
        commandVisible: false,
        missing: { ...skill.missing, env: ["CALENDAR_API_KEY"] },
      })),
    });
    await runCommand(["info", "calendar"]);
    expect(mocks.stdout).toHaveLength(1);
    expect(mocks.stdout[0]).toContain(`Save via CLI: openclaw config set ${configPath} YOUR_KEY`);
  });
  it("renders one status per alternative group", async () => {
    const anyBins = ["node", "openclaw-definitely-missing-runtime"];
    const os = ["linux", "darwin"];
    const report: SkillStatusReport = {
      ...mocks.report,
      skills: mocks.report.skills.map((skill) => ({
        ...skill,
        eligible: false,
        modelVisible: false,
        commandVisible: false,
        platformIncompatible: false,
        requirements: {
          bins: ["present-bin", "missing-bin"],
          anyBins,
          env: ["PRESENT_ENV", "MISSING_ENV"],
          config: ["present.config", "missing.config"],
          os,
        },
        missing: {
          bins: ["missing-bin"],
          anyBins: [],
          env: ["MISSING_ENV"],
          config: ["missing.config"],
          os: [],
        },
      })),
    };
    mocks.status.mockReturnValue(report);
    await runCommand(["info", "calendar"]);
    expect(mocks.stdout).toHaveLength(1);
    expect(mocks.stdout[0]).toContain(
      `Any binaries: ✓ (any of: node, openclaw-definitely-missing-runtime)`,
    );
    expect(mocks.stdout[0]).toContain(`OS: ✓ (linux, darwin)`);
    expect(mocks.stdout[0]).toContain("Binaries: ✓ present-bin, ✗ missing-bin");
    expect(mocks.stdout[0]).toContain("Environment: ✓ PRESENT_ENV, ✗ MISSING_ENV");
    expect(mocks.stdout[0]).toContain("Config: ✓ present.config, ✗ missing.config");
    await runCommand(["info", "calendar", "--json"]);
    expect(mocks.stdout[1]).toBe(JSON.stringify(report.skills[0], null, 2));
  });

  it("uses Gateway skills.status instead of local status when reachable", async () => {
    mocks.gateway.mockResolvedValue({
      ...mocks.report,
      agentId: "writer",
      workspaceDir: "/gateway/workspace-writer",
    });
    await runCommand(["check", "--agent", "writer", "--json"]);
    expect(mocks.gateway).toHaveBeenCalledWith({
      config: {},
      method: "skills.status",
      params: { agentId: "writer" },
      timeoutMs: 1_500,
      clientName: "cli",
      mode: "cli",
    });
    expect(mocks.status).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.stdout.at(-1) ?? "{}")).toMatchObject({
      workspaceDir: "/gateway/workspace-writer",
      eligible: ["calendar"],
      missingRequirements: [],
    });
  });
  it("does not substitute local skills after an explicit remote Gateway failure", async () => {
    mocks.config.mockReturnValue({
      gateway: { mode: "remote", remote: { url: "ws://127.0.0.1:9" } },
    });
    mocks.gateway.mockRejectedValue(new Error("Gateway not reachable: ws://127.0.0.1:9"));
    await expect(runCommand(["list", "--json"])).rejects.toThrow("__exit__:1");
    expect(mocks.errors).toEqual(["Gateway not reachable: ws://127.0.0.1:9"]);
    expect(mocks.stdout).toEqual([]);
    expect(mocks.status).not.toHaveBeenCalled();
  });
  it.each([
    {
      label: "request validation",
      root: false,
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: 'invalid skills.status params: unknown agent id "retired"',
      }),
    },
    { label: "authentication close", root: true, error: transportError(1008) },
  ])("does not substitute implicit-local skills after $label", async ({ error, root }) => {
    mocks.gateway.mockRejectedValue(error);
    const command = runCommand(["list", "--json"]);
    if (root) {
      await expect(command).rejects.toBe(error);
      expect(mocks.errors).toEqual([]);
    } else {
      await expect(command).rejects.toThrow("__exit__:1");
      expect(mocks.errors).toEqual([error.message]);
    }
    expect(mocks.stdout).toEqual([]);
    expect(mocks.status).not.toHaveBeenCalled();
  });
  it("rejects an unknown agent before resolving a skills workspace", async () => {
    mocks.explicitAgent.mockImplementation((_config, agent) =>
      resolveConfiguredAgentId({ agents: { entries: { main: {}, writer: {} } } }, agent),
    );
    await expect(runCommand(["list", "--agent", "nope-agent"])).rejects.toThrow("__exit__:1");
    expect(mocks.errors).toEqual([
      'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
    ]);
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
  it("rejects a blank explicit skills agent", async () => {
    await expect(runCommand(["check", "--agent", "   "])).rejects.toThrow("__exit__:1");
    expect(mocks.errors).toEqual(["--agent must not be blank"]);
    expect(mocks.explicitAgent).not.toHaveBeenCalled();
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
  it("redacts secrets from rendered skills CLI errors", async () => {
    const secret = "sk-abcdefghijklmnopqrstuv";
    mocks.defaultAgent.mockImplementationOnce(() => {
      throw new Error(`Skill lookup failed with token=${secret}`);
    });
    await expect(runCommand(["list"])).rejects.toThrow("__exit__:1");
    expect(mocks.errors).toHaveLength(1);
    expect(mocks.errors[0]).toContain("Skill lookup failed");
    expect(mocks.errors[0]).not.toContain(secret);
  });
  it("keeps human skills list output on stdout", async () => {
    await runCommand(["list"]);
    expect(mocks.config).toHaveBeenCalledWith({ skipPluginValidation: true });
    expect(mocks.runtime.writeStdout).toHaveBeenCalledOnce();
    expect(mocks.runtime.log).not.toHaveBeenCalled();
    expect(mocks.errors).toEqual([]);
    expect(mocks.stdout.at(-1)).toContain("calendar");
    expect(mocks.stdout.at(-1)).toContain("openclaw skills search");
  });
});
