import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { resolveClaudeCliProjectDirForWorkspace } from "../agents/command/claude-cli-project-dir.js";
import { captureConfigHealthStateStore } from "../config/io.health-state.js";
import { createConfigIO } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createWindowsCmdShimFixture } from "../test-helpers/windows-cmd-shim.js";
import { setTestEnvValue } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createClaudeAuthFixture } from "./server.chat-cli-auth.test-support.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import * as gatewayFixture from "./test-helpers.e2e.js";

// Only the external executable is a fixture. The registered Gateway, Anthropic
// plugin, profile selection, credential transport, and transcript writer are real.
const cases: {
  name: string;
  order: NonNullable<OpenClawConfig["auth"]>["order"];
  credential?: AuthProfileCredential;
  nativeContinuity?: boolean;
  reply: string;
}[] = [
  {
    name: "keeps native account history when a saved token appears and uses it for a new session",
    order: undefined,
    nativeContinuity: true,
    reply: "Native account reply.",
  },
  {
    name: "uses a saved canonical paste-token without an explicit account selection or native login",
    order: undefined,
    credential: { type: "token", provider: "anthropic", token: "synthetic-pasted-anthropic-token" },
    reply: "Saved account reply.",
  },
  {
    name: "uses a saved canonical paste-token selected by the canonical account order",
    order: { anthropic: ["anthropic:pasted"] },
    credential: { type: "token", provider: "anthropic", token: "synthetic-pasted-anthropic-token" },
    reply: "Saved account reply.",
  },
  {
    name: "honors an explicit empty CLI account order despite a saved canonical paste-token",
    order: { "claude-cli": [] },
    credential: { type: "token", provider: "anthropic", token: "synthetic-pasted-anthropic-token" },
    reply: "No managed credential supplied.",
  },
  {
    name: "leaves native authentication in charge when only a canonical API key is saved",
    order: undefined,
    credential: { type: "api_key", provider: "anthropic", key: "synthetic-pasted-anthropic-key" },
    reply: "No managed credential supplied.",
  },
];

type CliAuthGateway = Awaited<ReturnType<typeof gatewayFixture.startGatewayWithClient>>;
type CliAuthFixture = {
  state: OpenClawTestState;
  gateway: CliAuthGateway;
  cfg: OpenClawConfig;
  modelRef: string;
  token: string;
  executable: string;
  nativeRoot: string;
};

describe.for(cases)("chat.send $name", (testCase) => {
  let fixture: CliAuthFixture;
  let caseWork: Promise<void> | undefined;

  // Cold Gateway bootstrap uses the fixture budget; the test deadline covers account transitions.
  beforeEach(async ({ signal, onTestFinished }) => {
    caseWork = undefined;
    const acquisition = prepareCliAuthFixture(testCase, signal);
    // Hook cancellation still joins acquisition; cleanup cannot race a late Gateway start.
    onTestFinished(async () => {
      await caseWork?.catch(() => undefined);
      const acquired = await acquisition.catch(() => undefined);
      if (acquired) {
        await cleanupCliAuthFixture(acquired);
      }
    });
    fixture = await acquisition;
  });

  it("preserves account selection and session history", { timeout: 90_000 }, ({ signal }) => {
    caseWork = executeCliAuthCase(fixture, testCase, signal);
    return caseWork;
  });
});

async function cleanupCliAuthFixture({
  state,
  gateway,
}: {
  state: OpenClawTestState;
  gateway?: CliAuthGateway;
}): Promise<void> {
  try {
    if (gateway) {
      try {
        await gatewayFixture.disconnectGatewayClient(gateway.client);
      } finally {
        await gateway.server.close({ reason: "CLI auth test cleanup" });
      }
    }
  } finally {
    await state.cleanup();
  }
}

async function prepareCliAuthFixture(
  { order, credential, nativeContinuity }: (typeof cases)[number],
  signal: AbortSignal,
): Promise<CliAuthFixture> {
  signal.throwIfAborted();
  // Each case changes startup auth configuration and owns an empty native-login root.
  const state = await createOpenClawTestState({
    label: "chat-cli-auth",
    env: {
      PATH: undefined,
      OPENCLAW_PATH_BOOTSTRAPPED: "1",
      CLAUDE_CONFIG_DIR: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: undefined,
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "dist/extensions"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
    },
  });
  let gateway: CliAuthGateway | undefined;
  try {
    signal.throwIfAborted();
    // Persisted native continuity must exercise Claude's hashed long-path key,
    // including on CI hosts whose temporary roots would otherwise be short.
    const workspaceDir =
      nativeContinuity && state.workspaceDir.length <= 200
        ? path.join(state.workspaceDir, "w".repeat(201 - state.workspaceDir.length))
        : state.workspaceDir;
    await fs.mkdir(workspaceDir, { recursive: true });
    const binDir = state.path("bin");
    const scriptPath = path.join(binDir, "claude.cjs");
    const executable = path.join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
    const fixtureScript = createClaudeAuthFixture(
      (await fs.realpath(workspaceDir)).normalize("NFC"),
      resolveClaudeCliProjectDirForWorkspace({
        workspaceDir,
        homeDir: state.home,
      }),
    );
    await fs.mkdir(binDir);
    if (process.platform === "win32") {
      await createWindowsCmdShimFixture({
        shimPath: executable,
        scriptPath,
        shimLine: `"${process.execPath}" "%~dp0\\claude.cjs" %*`,
      });
    } else {
      await fs.writeFile(executable, `#!${process.execPath}\n${fixtureScript}`, {
        mode: 0o755,
      });
    }
    await fs.writeFile(scriptPath, fixtureScript);
    setTestEnvValue("PATH", binDir);
    const nativeRoot = path.join(state.home, ".claude");
    setTestEnvValue("CLAUDE_CONFIG_DIR", nativeRoot);
    await fs.mkdir(nativeRoot);
    if (nativeContinuity) {
      await fs.writeFile(
        path.join(nativeRoot, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "synthetic-native-login-token",
            refreshToken: "synthetic-native-refresh-token",
            expiresAt: Date.now() + 3_600_000,
            scopes: ["user:inference", "user:profile"],
            subscriptionType: "max",
          },
        }),
      );
    }
    await state.writeAuthProfiles({
      version: 1,
      profiles: credential ? { "anthropic:pasted": credential } : {},
    });
    const modelRef = "anthropic/claude-sonnet-4-6";
    const token = "chat-cli-auth-test";
    const cfg = {
      ...(order ? { auth: { order } } : {}),
      agents: {
        defaults: {
          workspace: workspaceDir,
          skipBootstrap: true,
          utilityModel: "",
          heartbeat: { every: "0m" },
          model: { primary: modelRef },
          models: { [modelRef]: { agentRuntime: { id: "claude-cli" } } },
        },
      },
      plugins: {
        enabled: true,
        allow: ["anthropic"],
        entries: { anthropic: { enabled: true, config: { sessionCatalog: { enabled: false } } } },
        slots: { memory: "none" },
      },
      tools: { profile: "minimal" },
      gateway: { auth: { mode: "token", token } },
    } satisfies OpenClawConfig;
    signal.throwIfAborted();
    expect(resolveExecutablePath("claude")).toBe(executable);
    gateway = await gatewayFixture.startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    signal.throwIfAborted();
    await gateway.server.startupSettled;
    signal.throwIfAborted();
    return { state, gateway, cfg, modelRef, token, executable, nativeRoot };
  } catch (error) {
    await cleanupCliAuthFixture({ state, gateway });
    throw error;
  }
}

async function executeCliAuthCase(
  fixture: CliAuthFixture,
  { reply, nativeContinuity }: (typeof cases)[number],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { state, cfg, modelRef, token, executable, nativeRoot } = fixture;
  const sessionKey = `agent:main:cli-auth-${randomUUID()}`;
  const sendTurn = async (
    client: CliAuthGateway["client"],
    turnSessionKey: string,
    message: string,
    expectedReply: string,
  ) => {
    signal.throwIfAborted();
    expect(resolveExecutablePath("claude")).toBe(executable);
    const accepted = await client.request<{ runId: string; status: string }>("chat.send", {
      sessionKey: turnSessionKey,
      message,
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    signal.throwIfAborted();
    expect(accepted.status).toBe("started");
    const completed = await client.request<{ status: string }>(
      "agent.wait",
      { runId: accepted.runId, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    );
    signal.throwIfAborted();
    expect(completed.status).toBe("ok");
    const history = await client.request<{ messages: unknown[] }>("chat.history", {
      sessionKey: turnSessionKey,
    });
    expect(history.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([{ type: "text", text: expectedReply }]),
      }),
    );
  };
  const marker = `native-history-${randomUUID()}`;
  await sendTurn(
    fixture.gateway.client,
    sessionKey,
    nativeContinuity ? `Remember ${marker}.` : "Reply using the saved account.",
    reply,
  );
  if (nativeContinuity) {
    const original =
      loadGatewaySessionEntryReadOnly(sessionKey).entry?.cliSessionBindings?.["claude-cli"];
    expect(original?.sessionId).toBeTruthy();
    expect(original?.authProfileId).toBeUndefined();
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "anthropic:pasted": {
          type: "token",
          provider: "anthropic",
          token: "synthetic-pasted-anthropic-token",
        },
      },
    });
    await gatewayFixture.disconnectGatewayClient(fixture.gateway.client);
    await fixture.gateway.server.close({ reason: "Verify persisted native account continuity" });
    signal.throwIfAborted();
    expect(resolveExecutablePath("claude")).toBe(executable);
    fixture.gateway = await gatewayFixture.startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    signal.throwIfAborted();
    await fixture.gateway.server.startupSettled;
    signal.throwIfAborted();
    await sendTurn(
      fixture.gateway.client,
      sessionKey,
      "Recall the marker from our previous turn.",
      `Native history: ${marker}.`,
    );
    const resumed =
      loadGatewaySessionEntryReadOnly(sessionKey).entry?.cliSessionBindings?.["claude-cli"];
    expect(resumed?.sessionId).toBe(original?.sessionId);
    expect(resumed?.authProfileId).toBe(original?.authProfileId);
    const savedSessionKey = `agent:main:cli-auth-${randomUUID()}`;
    await sendTurn(
      fixture.gateway.client,
      savedSessionKey,
      "Reply using the saved account.",
      "Saved account reply.",
    );
    const saved =
      loadGatewaySessionEntryReadOnly(savedSessionKey).entry?.cliSessionBindings?.["claude-cli"];
    expect(saved?.authProfileId).toBe("anthropic:pasted");

    signal.throwIfAborted();
    await fixture.gateway.client.request("sessions.patch", {
      key: sessionKey,
      model: `${modelRef}@anthropic:pasted`,
    });
    await sendTurn(
      fixture.gateway.client,
      sessionKey,
      "Reply using my explicit account selection.",
      "Saved account reply.",
    );
    const explicitlySelected =
      loadGatewaySessionEntryReadOnly(sessionKey).entry?.cliSessionBindings?.["claude-cli"];
    expect(explicitlySelected?.authProfileId).toBe("anthropic:pasted");
    expect(explicitlySelected?.sessionId).not.toBe(original?.sessionId);

    const replacement = {
      type: "token",
      provider: "anthropic",
      token: "synthetic-replacement-anthropic-token",
    } satisfies AuthProfileCredential;
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "anthropic:pasted": {
          type: "token",
          provider: "anthropic",
          token: "synthetic-pasted-anthropic-token",
        },
        "anthropic:replacement": replacement,
      },
      order: { anthropic: ["anthropic:replacement", "anthropic:pasted"] },
    });
    await sendTurn(
      fixture.gateway.client,
      savedSessionKey,
      "Keep our existing account despite the new default.",
      "Saved account reply.",
    );
    const retained =
      loadGatewaySessionEntryReadOnly(savedSessionKey).entry?.cliSessionBindings?.["claude-cli"];
    expect(retained?.authProfileId).toBe(saved?.authProfileId);
    expect(retained?.sessionId).toBe(saved?.sessionId);

    await state.writeAuthProfiles({
      version: 1,
      profiles: { "anthropic:replacement": replacement },
      order: { anthropic: ["anthropic:replacement"] },
    });
    await sendTurn(
      fixture.gateway.client,
      savedSessionKey,
      "Use the available account after my old account was removed.",
      "Replacement account reply.",
    );
    const replaced =
      loadGatewaySessionEntryReadOnly(savedSessionKey).entry?.cliSessionBindings?.["claude-cli"];
    expect(replaced?.authProfileId).toBe("anthropic:replacement");
    expect(replaced?.sessionId).not.toBe(saved?.sessionId);
    const turns: {
      sessionId: string;
      resume: boolean;
      savedToken: boolean;
      resumedHistory: unknown[];
    }[] = (await fs.readFile(path.join(nativeRoot, "turns.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(turns).toHaveLength(6);
    expect(turns[0]).toMatchObject({
      sessionId: original?.sessionId,
      resume: false,
      savedToken: false,
    });
    expect(turns[1]).toMatchObject({
      sessionId: original?.sessionId,
      resume: true,
      savedToken: false,
    });
    expect(JSON.stringify(turns[1]?.resumedHistory)).toContain(marker);
    expect(turns[2]).toMatchObject({ resume: false, savedToken: true, resumedHistory: [] });
    expect(turns[2]?.sessionId).not.toBe(original?.sessionId);
    expect(turns[3]).toMatchObject({
      sessionId: explicitlySelected?.sessionId,
      resume: false,
      savedToken: true,
      resumedHistory: [],
    });
    expect(turns[4]).toMatchObject({ sessionId: saved?.sessionId, savedToken: true });
    expect(turns[5]).toMatchObject({
      sessionId: replaced?.sessionId,
      resume: false,
      savedToken: true,
      resumedHistory: [],
    });
  }
}

it("persists config health in the isolated Gateway process", async () => {
  const state = await createOpenClawTestState({
    label: "gateway-config-health",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  const warn = vi.fn();
  const deps = { env: state.env, homedir: () => state.home, logger: { warn, error: vi.fn() } };
  const readHealth = async () => {
    using health = captureConfigHealthStateStore(deps, state.configPath);
    return (await health.read())?.state;
  };
  try {
    await state.writeConfig({ gateway: { mode: "local" } });
    const snapshot = await createConfigIO({
      ...deps,
      configPath: state.configPath,
    }).readConfigFileSnapshot();
    expect(snapshot.valid).toBe(true);
    const observed = await readHealth();
    expect(observed?.entries?.[state.configPath]?.lastKnownGood?.hash).toBe(snapshot.hash);
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(state.env));
    expect(await readHealth()).toEqual(observed);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    await state.cleanup();
  }
});

it("does not start a Gateway after CLI auth fixture acquisition is cancelled", async () => {
  const controller = new AbortController();
  const cancelled = new Error("Cancel after writing the fixture executable");
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const writeFile = fs.writeFile;
  const startup = vi.spyOn(gatewayFixture, "startGatewayWithClient");
  const write = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    await writeFile(...args);
    if (typeof args[0] === "string" && path.basename(args[0]) === "claude.cjs") {
      controller.abort(cancelled);
    }
  });
  try {
    await expect(prepareCliAuthFixture(cases[0]!, controller.signal)).rejects.toBe(cancelled);
    expect(startup).not.toHaveBeenCalled();
    expect(process.env.PATH).toBe(originalPath);
    expect(process.env.HOME).toBe(originalHome);
  } finally {
    write.mockRestore();
    startup.mockRestore();
  }
});
