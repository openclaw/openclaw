import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeAuthProfilesAcrossOwnerStores } from "../agents/auth-profiles/profiles.js";
import { hasAnyAuthProfileStoreSourceAsync } from "../agents/auth-profiles/source-check.js";
import { loadAuthProfileStoreForRuntimeAsync } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { resolveClaudeCliProjectDirForWorkspace } from "../agents/command/claude-cli-project-dir.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { createWindowsCmdShimFixture } from "../test-helpers/windows-cmd-shim.js";
import { setTestEnvValue } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { waitForCatalogPublication } from "./server-methods/models-auth-catalog.test-support.js";
import {
  createClaudeAuthFixture,
  createClaudeCliGatewayConfig,
  createClaudeCliGatewayEnv,
} from "./server.chat-cli-auth.test-support.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils.js";
import * as gatewayFixture from "./test-helpers.e2e.js";

const savedCredential = {
  type: "token",
  provider: "anthropic",
  token: "synthetic-pasted-anthropic-token",
} satisfies AuthProfileCredential;

// Only the external executable is a fixture. The registered Gateway, Anthropic
// plugin, profile selection, credential transport, and transcript writer are real.
const cases: {
  name: string;
  order: NonNullable<OpenClawConfig["auth"]>["order"];
  credential?: AuthProfileCredential;
  nativeContinuity?: boolean;
  hookAccounts?: boolean;
  reply: string;
}[] = [
  {
    name: "keeps native account history when a saved token appears and uses it for a new session",
    order: undefined,
    nativeContinuity: true,
    reply: "Native account reply.",
  },
  {
    name: "honors an explicit empty CLI account order despite a saved canonical paste-token",
    order: { "claude-cli": [] },
    credential: savedCredential,
    reply: "No managed credential supplied.",
  },
  {
    name: "enforces hook account selection at the real CLI process boundary",
    order: undefined,
    nativeContinuity: true,
    hookAccounts: true,
    reply: "Native account reply.",
  },
];

type CliAuthGateway = Awaited<ReturnType<typeof gatewayFixture.startGatewayWithClient>>;
type CliAuthFixture = Awaited<ReturnType<typeof prepareCliAuthFixture>>;
const readBinding = async (sessionKey: string) =>
  (await loadGatewaySessionEntryReadOnlyAsync(sessionKey)).entry?.cliSessionBindings?.[
    "claude-cli"
  ];
const startCliAuthGateway = (state: OpenClawTestState, cfg: OpenClawConfig, token: string) =>
  gatewayFixture.startGatewayWithClient({
    cfg,
    configPath: state.configPath,
    token,
    scopes: ["operator.admin", "operator.read", "operator.write"],
  });

async function writeProfiles(
  state: OpenClawTestState,
  profiles: Record<string, AuthProfileCredential>,
  order?: string[],
) {
  await state.writeAuthProfiles({
    version: 1,
    profiles,
    ...(order && { order: { anthropic: order } }),
  });
}

describe.for(cases)("Gateway $name", (testCase) => {
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
    caseWork = testCase.hookAccounts
      ? executeHookAuthCase(fixture, signal)
      : executeCliAuthCase(fixture, testCase, signal);
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
  {
    order,
    credential,
    nativeContinuity,
    hookAccounts,
  }: Pick<(typeof cases)[number], "order" | "credential" | "nativeContinuity" | "hookAccounts">,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  // Each case changes startup auth configuration and owns an empty native-login root.
  const state = await createOpenClawTestState({
    label: "chat-cli-auth",
    env: createClaudeCliGatewayEnv(),
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
    // An empty persisted store would hide the hook's no-source shortcut regression.
    if (!hookAccounts) {
      await writeProfiles(state, credential ? { "anthropic:pasted": credential } : {});
    }
    const modelRef = "anthropic/claude-sonnet-4-6";
    const token = "chat-cli-auth-test";
    const cfg: OpenClawConfig = {
      ...(order ? { auth: { order } } : {}),
      ...createClaudeCliGatewayConfig(workspaceDir, modelRef, token),
    };
    if (hookAccounts) {
      cfg.agents!.ownership = "explicit";
      cfg.agents!.entries = {
        main: { workspace: workspaceDir },
        missing: { workspace: workspaceDir, model: `${modelRef}@anthropic:missing` },
        native: { workspace: workspaceDir, model: `${modelRef}@anthropic:claude-cli` },
      };
      cfg.hooks = {
        enabled: true,
        token: "hook-cli-auth-test",
        allowRequestSessionKey: true,
        allowedSessionKeyPrefixes: ["hook:"],
        allowedAgentIds: ["main", "missing", "native"],
      };
    }
    signal.throwIfAborted();
    expect(resolveExecutablePath("claude")).toBe(executable);
    gateway = await startCliAuthGateway(state, cfg, token);
    signal.throwIfAborted();
    await gateway.server.startupSettled;
    signal.throwIfAborted();
    return { state, gateway, cfg, modelRef, token, executable, nativeRoot };
  } catch (error) {
    await cleanupCliAuthFixture({ state, gateway });
    throw error;
  }
}

async function executeHookAuthCase(fixture: CliAuthFixture, signal: AbortSignal) {
  const { state, gateway, nativeRoot, modelRef } = fixture;
  const requests: Array<string | undefined> = [];
  const provider = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      http.createServer((request, response) => {
        requests.push(request.headers.authorization);
        request.resume();
        response.end("fixture response");
      }),
  });
  try {
    await fs.writeFile(
      path.join(nativeRoot, "provider-url.txt"),
      `http://127.0.0.1:${provider.claim.port}/inference`,
    );
    const launchLog = path.join(nativeRoot, "execution-launches.log");
    await fs.writeFile(launchLog, "", { flag: "wx" });
    const launches = async () => (await fs.readFile(launchLog, "utf8")).split("\n").length - 1;
    const key = (agentId: string) => `hook:account-proof:${agentId}`;
    const canonicalKey = (agentId: string) => `agent:${agentId}:${key(agentId)}`;
    const post = async (agentId: string, model?: string) => {
      const response = await fetch(`http://127.0.0.1:${gateway.port}/hooks/agent`, {
        method: "POST",
        headers: { authorization: "Bearer hook-cli-auth-test", "content-type": "application/json" },
        body: JSON.stringify({
          name: "Account isolation",
          message: "Reply using the selected account.",
          agentId,
          sessionKey: key(agentId),
          sessionMode: "persistent",
          wakeMode: "next-heartbeat",
          model,
          deliver: false,
          waitForCompletion: true,
          idempotencyKey: randomUUID(),
        }),
        signal,
      });
      return { status: response.status, body: await response.json() };
    };
    // Fresh persistent hooks create their own session before selecting its agent default.
    for (const agentId of ["main", "missing"]) {
      expect(await hasAnyAuthProfileStoreSourceAsync(state.agentDir(agentId))).toBe(false);
      const before = await launches();
      const requestCount = requests.length;
      const result = await post(
        agentId,
        agentId === "main" ? `${modelRef}@anthropic:missing` : undefined,
      );
      // Soft checks expose both independent no-source regressions when run on the base.
      expect.soft(result).toMatchObject({ status: 502, body: { ok: false } });
      expect.soft(await launches()).toBe(before);
      expect.soft(requests).toHaveLength(requestCount);
    }
    for (const agentId of ["main", "native"]) {
      const before = requests.length;
      expect(await post(agentId)).toMatchObject({
        status: 200,
        body: { ok: true, completion: { status: "ok" } },
      });
      expect(requests.slice(before)).toEqual(["Bearer synthetic-native-login-token"]);
    }

    for (const agentId of ["main", "native"]) {
      await state.writeAuthProfiles(
        { version: 1, profiles: { "anthropic:pasted": savedCredential } },
        agentId,
      );
    }
    await gateway.client.request("sessions.patch", {
      key: canonicalKey("main"),
      model: `${modelRef}@anthropic:claude-cli`,
    });
    const beforeNative = requests.length;
    expect(await post("main")).toMatchObject({
      status: 200,
      body: { ok: true, completion: { status: "ok" } },
    });
    expect(requests.slice(beforeNative)).toEqual(["Bearer synthetic-native-login-token"]);
    await gateway.client.request("sessions.patch", {
      key: canonicalKey("native"),
      model: `${modelRef}@anthropic:pasted`,
    });
    expect(
      (await loadGatewaySessionEntryReadOnlyAsync(canonicalKey("native"))).entry,
    ).toMatchObject({
      authProfileOverride: "anthropic:pasted",
      authProfileOverrideSource: "user",
    });
    for (const model of [undefined, `${modelRef}@anthropic:missing`]) {
      const before = requests.length;
      expect(await post("native", model)).toMatchObject({
        status: 200,
        body: { ok: true, completion: { status: "ok" } },
      });
      expect(requests.slice(before)).toEqual(["Bearer synthetic-pasted-anthropic-token"]);
    }
    // Remove both exact owners: an inherited shared copy is still a usable account.
    for (const agentId of ["main", "native"]) {
      expect(
        await removeAuthProfilesAcrossOwnerStores({
          agentDir: state.agentDir(agentId),
          profileIds: ["anthropic:pasted"],
        }),
      ).toBe(true);
    }
    expect(
      (
        await loadAuthProfileStoreForRuntimeAsync(state.agentDir("native"), {
          readOnly: true,
          allowKeychainPrompt: false,
        })
      ).profiles["anthropic:pasted"],
    ).toBeUndefined();
    const beforeRevocation = await launches();
    const requestsBeforeRevocation = requests.length;
    expect(await post("native")).toMatchObject({ status: 502, body: { ok: false } });
    expect(await launches()).toBe(beforeRevocation);
    expect(requests).toHaveLength(requestsBeforeRevocation);
  } finally {
    try {
      await provider.releaseListener();
    } finally {
      await provider.claim.release();
    }
  }
}

async function executeCliAuthCase(
  fixture: CliAuthFixture,
  { reply, nativeContinuity }: (typeof cases)[number],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { state, cfg, modelRef, token, nativeRoot } = fixture;
  const sessionKey = `agent:main:cli-auth-${randomUUID()}`;
  const sendTurn = async (turnSessionKey: string, message: string, expectedReply: string) => {
    const { client } = fixture.gateway;
    signal.throwIfAborted();
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
    sessionKey,
    nativeContinuity ? `Remember ${marker}.` : "Reply using the saved account.",
    reply,
  );
  if (nativeContinuity) {
    const turnsBeforeSelection = await fs.readFile(path.join(nativeRoot, "turns.jsonl"), "utf8");
    const refusedKey = `agent:main:missing-account-${randomUUID()}`;
    await expect(
      fixture.gateway.client.request("sessions.create", {
        agentId: "main",
        key: refusedKey,
        model: `${modelRef}@anthropic:missing`,
      }),
    ).rejects.toMatchObject({
      message: `A runtime is not available for ${modelRef}: selected account "anthropic:missing" is unavailable. Restore that account, or change the explicit or default account selection.`,
    });
    expect((await loadGatewaySessionEntryReadOnlyAsync(refusedKey)).entry).toBeUndefined();
    const personalKey = `agent:main:missing-personal-account-${randomUUID()}`;
    await fixture.gateway.client.request("sessions.create", {
      agentId: "main",
      key: personalKey,
      model: modelRef,
    });
    // Removed personal accounts leave their exact session pin behind. Re-selecting
    // the same model must report recovery without exposing that private locator.
    const personalProfileId = `personal:${randomUUID()}:${randomUUID()}`;
    const retainedPin = {
      authProfileOverride: personalProfileId,
      authProfileOverrideSource: "user" as const,
    };
    expect(
      await patchSessionEntryCore({ agentId: "main", sessionKey: personalKey }, () => retainedPin),
    ).toMatchObject(retainedPin);
    await expect(
      fixture.gateway.client.request("sessions.patch", { key: personalKey, model: modelRef }),
    ).rejects.toMatchObject({
      message: `A runtime is not available for ${modelRef}: selected personal account is unavailable. Restore that account, or change the explicit or default account selection.`,
    });
    expect((await loadGatewaySessionEntryReadOnlyAsync(personalKey)).entry).toMatchObject(
      retainedPin,
    );
    expect(await fs.readFile(path.join(nativeRoot, "turns.jsonl"), "utf8")).toBe(
      turnsBeforeSelection,
    );
    const original = await readBinding(sessionKey);
    expect(original?.sessionId).toBeTruthy();
    expect(original?.authProfileId).toBeUndefined();
    await writeProfiles(state, { "anthropic:pasted": savedCredential });
    await gatewayFixture.disconnectGatewayClient(fixture.gateway.client);
    await fixture.gateway.server.close({ reason: "Verify persisted native account continuity" });
    signal.throwIfAborted();
    fixture.gateway = await startCliAuthGateway(state, cfg, token);
    signal.throwIfAborted();
    await fixture.gateway.server.startupSettled;
    signal.throwIfAborted();
    await sendTurn(
      sessionKey,
      "Recall the marker from our previous turn.",
      `Native history: ${marker}.`,
    );
    const resumed = await readBinding(sessionKey);
    expect(resumed?.sessionId).toBe(original?.sessionId);
    expect(resumed?.authProfileId).toBe(original?.authProfileId);
    const savedSessionKey = `agent:main:cli-auth-${randomUUID()}`;
    const sendSavedTurn = (key: string, message: string) =>
      sendTurn(key, message, "Saved account reply.");
    await sendSavedTurn(savedSessionKey, "Reply using the saved account.");
    const saved = await readBinding(savedSessionKey);
    expect(saved?.authProfileId).toBe("anthropic:pasted");

    signal.throwIfAborted();
    await fixture.gateway.client.request("sessions.patch", {
      key: sessionKey,
      model: `${modelRef}@anthropic:pasted`,
    });
    await sendSavedTurn(sessionKey, "Reply using my explicit account selection.");
    const explicitlySelected = await readBinding(sessionKey);
    expect(explicitlySelected?.authProfileId).toBe("anthropic:pasted");
    expect(explicitlySelected?.sessionId).not.toBe(original?.sessionId);

    const replacement = {
      type: "token",
      provider: "anthropic",
      token: "synthetic-replacement-anthropic-token",
    } satisfies AuthProfileCredential;
    await writeProfiles(
      state,
      {
        "anthropic:pasted": savedCredential,
        "anthropic:replacement": replacement,
      },
      ["anthropic:replacement", "anthropic:pasted"],
    );
    await sendSavedTurn(savedSessionKey, "Keep our existing account despite the new default.");
    expect(await readBinding(savedSessionKey)).toMatchObject({
      authProfileId: saved?.authProfileId,
      sessionId: saved?.sessionId,
    });

    await writeProfiles(state, { "anthropic:replacement": replacement }, ["anthropic:replacement"]);
    await sendTurn(
      savedSessionKey,
      "Use the available account after my old account was removed.",
      "Replacement account reply.",
    );
    const replaced = await readBinding(savedSessionKey);
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
    expect(turns).toMatchObject([
      { sessionId: original?.sessionId, resume: false, savedToken: false },
      { sessionId: original?.sessionId, resume: true, savedToken: false },
      { resume: false, savedToken: true, resumedHistory: [] },
      {
        sessionId: explicitlySelected?.sessionId,
        resume: false,
        savedToken: true,
        resumedHistory: [],
      },
      { sessionId: saved?.sessionId, savedToken: true },
      { sessionId: replaced?.sessionId, resume: false, savedToken: true, resumedHistory: [] },
    ]);
    expect(JSON.stringify(turns[1]?.resumedHistory)).toContain(marker);
    expect(turns[2]?.sessionId).not.toBe(original?.sessionId);
  }
}

it(
  "publishes Claude login changes after Gateway startup",
  { timeout: 90_000 },
  async ({ signal, onTestFinished }) => {
    const fixture = await prepareCliAuthFixture({ order: undefined }, signal);
    onTestFinished(() => cleanupCliAuthFixture(fixture));
    const credentials = path.join(fixture.nativeRoot, ".credentials.json");
    const probes = async () =>
      (await fs.readFile(path.join(fixture.nativeRoot, "auth-status.log"), "utf8")).split("\n")
        .length - 1;
    const available = async () => {
      const { models } = await fixture.gateway.client.request<{
        models: { provider: string; id: string; available?: boolean }[];
      }>("models.list", { view: "configured", agentId: "main" });
      return models.find((model) => `${model.provider}/${model.id}` === fixture.modelRef)
        ?.available;
    };
    const now = Date.now.bind(Date);
    let elapsed = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
    onTestFinished(() => clock.mockRestore());

    expect(await available()).toBe(false);
    await fs.writeFile(credentials, "{}");
    const startupProbes = await probes();
    expect(await available()).toBe(false);
    expect(await probes()).toBe(startupProbes);

    elapsed += 5 * 60_000;
    await waitForCatalogPublication({ signal, read: available, ready: (value) => value === true });
    const loginProbes = await probes();
    expect(loginProbes).toBe(startupProbes + 1);

    await fs.rm(credentials);
    elapsed += 5 * 60_000;
    await waitForCatalogPublication({ signal, read: available, ready: (value) => value === false });
    expect(await probes()).toBe(loginProbes + 1);
  },
);
