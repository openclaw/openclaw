import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import type { UserProfileIdentity } from "../../state/user-profiles.types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { catalogProvider } from "./session-catalog.fixtures.test-support.js";
import { sessionCatalogHandlers } from "./session-catalog.js";

const provider = (overrides: Partial<SessionCatalogProvider>) =>
  catalogProvider("codex", { label: "Codex", ...overrides });

let activeProvider: SessionCatalogProvider;
let blockedStart = vi.fn();
const enabled = { gateway: { cliAgents: { enabled: true } } };
const admin = { connId: "conn-1", connect: { scopes: ["operator.admin"] } };
const guestId = "profile-terminal-guest";
const guest = {
  sessions: { others: "view" },
  agents: ["research"],
  scopes: ["operator.read", "operator.write"],
};
const request = (overrides = {}) => ({
  catalogId: "codex",
  agentId: "main",
  cwd: process.cwd(),
  ...overrides,
});
function launchContext(open = vi.fn(), agentId = "main", cwd = "/agent/workspace") {
  return {
    isTerminalEnabled: () => true,
    terminalSessions: { open },
    resolveTerminalLaunchPolicy: () => ({
      ok: true,
      plan: { agentId, cwd, shell: "/bin/zsh", args: [] },
    }),
    isConnectionActive: () => true,
  };
}
type Respond = ReturnType<typeof vi.fn>;
function expectError(respond: Respond, code: string | undefined, message: unknown) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ ...(code ? { code } : {}), message }),
  );
}
vi.mock("./session-catalog-provider-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-catalog-provider-access.js")>()),
  catalogRegistrationSnapshot: () => ({ providers: [activeProvider] }),
}));
const handler = sessionCatalogHandlers["sessions.catalog.startTerminal"]!;

type TerminalTestClient = {
  authenticatedUserProfile?: { profileId: string };
  preparedSessionProfile?: UserProfileIdentity;
  connect?: { scopes?: string[] };
  connId?: string;
};

function startCall(
  params: unknown,
  config: Record<string, unknown> = {},
  client?: TerminalTestClient,
  contextOverrides: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  const completion = Promise.resolve(
    handler({
      params,
      respond,
      client,
      context: { getRuntimeConfig: () => config, ...contextOverrides },
    } as never),
  );
  return { completion, respond };
}

async function call(...args: Parameters<typeof startCall>) {
  const pending = startCall(...args);
  await pending.completion;
  return pending.respond;
}

describe("sessions.catalog.startTerminal", () => {
  beforeAll(async () => {
    await import("./terminal.js");
  });

  beforeEach(() => {
    blockedStart = vi.fn();
    activeProvider = provider({ startTerminalSession: blockedStart });
  });

  it.each<[string, Parameters<typeof startCall>, string, unknown]>([
    [
      "honors the cliAgents opt-out before terminal start",
      [request(), { gateway: { cliAgents: { enabled: false } } }],
      ErrorCodes.UNAVAILABLE,
      "CLI agent terminal start is disabled; enable gateway.cliAgents.enabled and retry",
    ],
    [
      "refuses terminal start when the terminal is disabled",
      [request(), enabled, { connId: "conn-1" }, { isTerminalEnabled: () => false }],
      ErrorCodes.UNAVAILABLE,
      "terminal is disabled; enable gateway.terminal.enabled and retry",
    ],
    [
      "refuses missing local cwd instead of falling back to home",
      [
        request({ cwd: "relative/missing" }),
        enabled,
        { connId: "conn-1" },
        { isTerminalEnabled: () => true, terminalSessions: {} },
      ],
      ErrorCodes.INVALID_REQUEST,
      "cwd must be an existing absolute directory; create or choose a worktree and retry",
    ],
    [
      "rejects terminal start before resolving a disallowed agent's provider target",
      [
        request(),
        {
          gateway: {
            cliAgents: { enabled: true },
            roles: { default: "guest", definitions: { guest } },
          },
        },
        {
          authenticatedUserProfile: { profileId: guestId },
          preparedSessionProfile: { profileId: guestId, aliases: new Set([guestId]), role: null },
          connId: "conn-1",
        },
        { isTerminalEnabled: () => true, terminalSessions: {} },
      ],
      ErrorCodes.FORBIDDEN,
      expect.stringContaining('cannot create sessions for agent "main"'),
    ],
    [
      "refuses sandboxed agents before requesting a terminal plan",
      [
        request({ agentId: "locked" }),
        enabled,
        admin,
        {
          isTerminalEnabled: () => true,
          terminalSessions: { open: vi.fn() },
          resolveTerminalLaunchPolicy: () => ({
            ok: false,
            block: { kind: "sandboxed", agentId: "locked", mode: "all" },
          }),
        },
      ],
      ErrorCodes.INVALID_REQUEST,
      expect.stringContaining('agent "locked" runs in a sandbox'),
    ],
  ])("%s", async (_name, args, code, message) => {
    const respond = await call(...args);
    expect(blockedStart).not.toHaveBeenCalled();
    expectError(respond, code, message);
  });

  it("rechecks local cwd after the provider plan resolves", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-catalog-start-"));
    const { promise: planGate, resolve: releasePlan } = createDeferred();
    const startTerminalSession = vi.fn(async () => {
      await planGate;
      return { kind: "local" as const, argv: ["codex"], cwd };
    });
    const open = vi.fn();
    activeProvider = provider({ startTerminalSession });

    try {
      const pending = startCall(request({ cwd }), enabled, admin, launchContext(open));
      await vi.waitFor(() => expect(startTerminalSession).toHaveBeenCalledOnce());
      await fs.rm(cwd, { recursive: true });
      releasePlan();
      await pending.completion;

      expect(open).not.toHaveBeenCalled();
      expectError(
        pending.respond,
        ErrorCodes.INVALID_REQUEST,
        expect.stringContaining(
          "cwd is no longer available; recreate or choose the worktree and retry",
        ),
      );
    } finally {
      releasePlan();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects local terminal start for a named profile before provider fallback", async () => {
    const cwd = process.cwd();
    const startTerminalSession = vi.fn(async (options: { allowProcessHomeFallback?: boolean }) => {
      throw new Error(
        options.allowProcessHomeFallback === false
          ? "local Test sessions are unavailable in isolated state"
          : "unguarded local terminal start",
      );
    });
    activeProvider = provider({ startTerminalSession: startTerminalSession as never });
    const home = os.userInfo().homedir;
    const stateDir = path.join(home, ".openclaw-dev");

    const respond = await withEnvAsync(
      {
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_HOME: undefined,
        OPENCLAW_PROFILE: "dev",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      async () => await call(request({ cwd }), enabled, admin, launchContext(vi.fn(), "main", cwd)),
    );

    expectError(
      respond,
      undefined,
      expect.stringContaining("local Test sessions are unavailable in isolated state"),
    );
  });

  it("reuses terminal.open admission and ownership without an OpenClaw model target", async () => {
    const cwd = process.cwd();
    const resolveCreateSession = vi.fn(() => undefined);
    const startTerminalSession = vi.fn(async () => ({
      kind: "local" as const,
      argv: ["codex", "--", "Inspect the failing test"],
      cwd,
      title: "Codex",
      env: { CODEX_HOME: "/tmp/codex-home" },
      pathEnv: "/usr/local/bin:/usr/bin:/bin",
    }));
    const terminal = { sessionId: "terminal-1", agentId: "research", cwd, shell: "/bin/zsh" };
    const open = vi.fn(async () => ({ ok: true as const, ...terminal }));
    activeProvider = provider({ startTerminalSession, resolveCreateSession });

    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5" },
          models: {
            "openai/gpt-5": {
              params: { responsesServerCompaction: true, responsesCompactThreshold: 42_000 },
            },
          },
        },
      },
    };
    const target = {
      hostId: "gateway:local",
      agentId: "research",
      cwd,
      initialMessage: "Inspect the failing test",
    };
    const respond = await call(request(target), config, admin, {
      ...launchContext(open, "research"),
      logGateway: { info: vi.fn() },
    });

    expect(resolveCreateSession).not.toHaveBeenCalled();
    expect(startTerminalSession).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(startTerminalSession).toHaveBeenCalledWith({
      ...target,
      allowProcessHomeFallback: false,
    });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { kind: "conn", connId: "conn-1" },
        agentId: "research",
        cwd,
        shell: "/bin/zsh",
        args: ["-il", "-c", "'codex' '--' 'Inspect the failing test'"],
        cols: 80,
        rows: 24,
        env: expect.objectContaining({
          CODEX_HOME: "/tmp/codex-home",
          PATH: "/usr/local/bin:/usr/bin:/bin",
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, { ...terminal, confined: false, title: "Codex" });
  });

  it("does not fall back to local when a node host was requested", async () => {
    const startTerminalSession = vi.fn(async ({ cwd }: { cwd: string }) => ({
      kind: "local" as const,
      argv: ["codex"],
      cwd,
    }));
    const open = vi.fn();
    activeProvider = provider({ startTerminalSession });
    const target = { hostId: "node:remote", agentId: "main", cwd: "/remote/worktree" };
    const respond = await call(request(target), enabled, admin, launchContext(open));

    expect(startTerminalSession).toHaveBeenCalledWith({
      ...target,
      allowProcessHomeFallback: false,
      nodeId: "remote",
    });
    expect(open).not.toHaveBeenCalled();
    expectError(
      respond,
      ErrorCodes.INVALID_REQUEST,
      expect.stringContaining("cannot start on the selected node"),
    );
  });
});
