import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  disposeAcpSessionManager,
  getAcpSessionManager,
  testing as managerTesting,
  type AcpSessionManager,
} from "../../acp/control-plane/manager.js";
import { testing as registryTesting } from "../../acp/runtime/registry.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTestPluginApi } from "../../plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/plugin-test-runtime.js";
import { createPluginStateKeyedStore } from "../../plugin-state/plugin-state-store.js";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  OpenClawPluginServiceV2,
} from "../../plugins/plugin-registration.types.js";
import type { OpenClawPluginDefinition } from "../../plugins/types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleAcpCommand } from "./commands-acp.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const peer = fileURLToPath(new URL("../../../test/fixtures/acp/owner-agent.mjs", import.meta.url));
const closedKey = "agent:main:acp:closed";
const keptKey = "agent:main:acp:kept";
const legacyKey = "agent:main:acp:legacy";

const cfg = {
  commands: { text: true },
  agents: { ownership: "explicit", entries: { main: {} } },
  acp: { enabled: true, backend: "acpx", dispatch: { enabled: true } },
} as OpenClawConfig;

type RegisteredPluginService = OpenClawPluginService | OpenClawPluginServiceV2;

type AcpxRuntimeService = OpenClawPluginService & {
  getRuntime: (ctx: OpenClawPluginServiceContext) => Promise<unknown>;
};

type StartedBackend = {
  service: AcpxRuntimeService;
  context: OpenClawPluginServiceContext;
  manager: AcpSessionManager;
};

function sessionFile(stateRoot: string, sessionKey: string): string {
  return path.join(stateRoot, "sessions", `${encodeURIComponent(sessionKey)}.json`);
}

async function snapshotStore(stateRoot: string) {
  const dir = path.join(stateRoot, "sessions");
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const rows = [];
  for (const name of names.toSorted()) {
    const buf = await fs.readFile(path.join(dir, name));
    const parsed = JSON.parse(buf.toString("utf8")) as {
      schema?: string;
      acpx_record_id?: string;
      acp_session_id?: string;
      closed?: boolean;
      acpx?: { reset_on_next_ensure?: boolean };
    };
    rows.push({
      file: name,
      bytes: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
      schema: parsed.schema ?? null,
      acpx_record_id: parsed.acpx_record_id ?? null,
      acp_session_id: parsed.acp_session_id ?? null,
      closed: parsed.closed ?? null,
      reset_on_next_ensure: parsed.acpx?.reset_on_next_ensure ?? null,
      acpx_keys: parsed.acpx ? Object.keys(parsed.acpx).toSorted() : [],
    });
  }
  return rows;
}

async function fixtureHistories(directory: string) {
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).toSorted();
  const rows = [];
  for (const name of names) {
    const parsed = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as {
      history?: string[];
    };
    rows.push({ file: name, history: parsed.history ?? null });
  }
  return rows;
}

function isAcpxRuntimeService(service: RegisteredPluginService): service is AcpxRuntimeService {
  if (service.apiVersion === 2) {
    return false;
  }
  return "getRuntime" in service && typeof service.getRuntime === "function";
}

async function loadBackend(stateRoot: string, peerDir: string, openClawStateDir: string) {
  registryTesting.resetAcpRuntimeBackendsForTests();
  managerTesting.resetAcpSessionManagerForTests();
  let registered: RegisteredPluginService | undefined;
  const { default: plugin } = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
    pluginId: "acpx",
    artifactBasename: "index.js",
  });
  const api = createTestPluginApi({
    id: "acpx",
    name: "ACPX Runtime",
    config: cfg,
    pluginConfig: {
      cwd: stateRoot,
      stateDir: stateRoot,
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
      timeoutSeconds: 5,
      piSessionCatalog: { enabled: false },
      agents: {
        fixture: {
          command: process.execPath,
          args: [peer, peerDir],
        },
      },
    },
    runtime: createPluginRuntimeMock({
      config: { current: () => cfg },
      state: {
        resolveStateDir: () => openClawStateDir,
        openKeyedStore: (options) => createPluginStateKeyedStore("acpx", options),
      },
    }),
    registerService(service) {
      registered = service;
    },
  });
  if (!plugin.register) {
    throw new Error("ACPX registration missing");
  }
  plugin.register(api);
  if (!registered || !isAcpxRuntimeService(registered)) {
    throw new Error("ACPX runtime service missing");
  }
  const context: OpenClawPluginServiceContext = {
    config: cfg,
    workspaceDir: stateRoot,
    stateDir: openClawStateDir,
    logger: api.logger,
  };
  return { service: registered, context };
}

async function startBackend(backend: {
  service: AcpxRuntimeService;
  context: OpenClawPluginServiceContext;
}): Promise<StartedBackend> {
  await backend.service.start(backend.context);
  await backend.service.getRuntime(backend.context);
  return { ...backend, manager: getAcpSessionManager() };
}

async function stopBackend(
  backend: { service: AcpxRuntimeService; context: OpenClawPluginServiceContext } | undefined,
): Promise<void> {
  await backend?.service.stop?.(backend.context);
  await disposeAcpSessionManager("proof-restart");
  managerTesting.resetAcpSessionManagerForTests();
}

async function openSession(manager: AcpSessionManager, sessionKey: string, cwd: string) {
  const initialized = await manager.initializeSession({
    cfg,
    sessionKey,
    agentId: "main",
    agent: "fixture",
    mode: "persistent",
    cwd,
  });
  return initialized.handle;
}

async function prompt(manager: AcpSessionManager, sessionKey: string, text: string) {
  const admission = prepareSystemAgentRunAdmission(cfg, text, "main", "acp-close-proof");
  const chunks: string[] = [];
  try {
    await manager.runTurn({
      cfg,
      admittedRunContext: await admission.admit("acp"),
      provenance: "human",
      sessionKey,
      agentId: "main",
      text,
      mode: "prompt",
      requestId: text,
      onEvent: (event) => {
        if (event.type === "text_delta" && event.text) {
          chunks.push(event.text);
        }
      },
    });
  } finally {
    admission.close();
  }
  return JSON.parse(chunks.join("")) as { sessionId: string; history: string[] };
}

it("closes through shipped /acp close, then restarts without resuming that session", async () => {
  const proof: Record<string, unknown> = {};
  await withOpenClawTestState({ label: "acp-close-command-proof" }, async (state) => {
    setRuntimeConfigSnapshot(cfg);
    const peerDir = path.join(state.root, "peer");
    await fs.mkdir(peerDir);
    const backend = await loadBackend(state.root, peerDir, state.stateDir);
    let started: StartedBackend | undefined;
    try {
      started = await startBackend(backend);
      const closed = await openSession(started.manager, closedKey, state.root);
      const kept = await openSession(started.manager, keptKey, state.root);
      const beforeClosed = await prompt(started.manager, closedKey, "before");
      const beforeKept = await prompt(started.manager, keptKey, "kept-before");
      proof.beforeClose = {
        closed: {
          backendSessionId: closed.backendSessionId,
          history: beforeClosed.history,
        },
        kept: {
          backendSessionId: kept.backendSessionId,
          history: beforeKept.history,
        },
        fixture: await fixtureHistories(peerDir),
      };
      await stopBackend(started);
      started = undefined;

      const keptRaw = JSON.parse(
        await fs.readFile(sessionFile(state.root, keptKey), "utf8"),
      ) as Record<string, unknown>;
      delete keptRaw.acpx;
      await fs.writeFile(sessionFile(state.root, keptKey), `${JSON.stringify(keptRaw)}\n`);
      const legacy = structuredClone(keptRaw);
      legacy.acpx_record_id = legacyKey;
      legacy.name = legacyKey;
      delete legacy.acpx;
      await fs.writeFile(sessionFile(state.root, legacyKey), `${JSON.stringify(legacy)}\n`);
      proof.preUpgradeOnDisk = await snapshotStore(state.root);
      const legacyHash = (
        proof.preUpgradeOnDisk as Array<{ acpx_record_id: string; sha256: string }>
      ).find((row) => row.acpx_record_id === legacyKey)?.sha256;

      started = await startBackend(backend);
      const keptAgain = await openSession(started.manager, keptKey, state.root);
      const keptReopen = await prompt(started.manager, keptKey, "kept-reopen");
      proof.preUpgradeOpen = {
        previousBackendSessionId: kept.backendSessionId,
        backendSessionId: keptAgain.backendSessionId,
        sameBackendSession: keptAgain.backendSessionId === kept.backendSessionId,
        history: keptReopen.history,
        store: await snapshotStore(state.root),
      };

      const params = buildCommandTestParams(
        "/acp close",
        cfg,
        { SessionKey: closedKey },
        {
          workspaceDir: state.root,
        },
      );
      params.sessionKey = closedKey;
      params.agentId = "main";
      params.command.commandBodyNormalized = "/acp close";
      params.command.rawBodyNormalized = "/acp close";
      params.command.senderIsOwner = true;
      params.command.isAuthorizedSender = true;
      params.command.senderId = "owner";
      params.command.assertOwnerCurrent = () => {};
      const commandResult = await handleAcpCommand(params, true);
      const commandText =
        commandResult && "reply" in commandResult ? (commandResult.reply?.text ?? "") : "";
      proof.command = { text: commandText };
      proof.afterCommand = {
        store: await snapshotStore(state.root),
        fixture: await fixtureHistories(peerDir),
      };
      expect(commandText).toContain(`Closed ACP session ${closedKey}`);
      await stopBackend(started);
      started = undefined;

      started = await startBackend(backend);
      const closedRestart = await openSession(started.manager, closedKey, state.root);
      const afterClosed = await prompt(started.manager, closedKey, "after");
      const keptRestart = await openSession(started.manager, keptKey, state.root);
      const afterKept = await prompt(started.manager, keptKey, "kept-after");
      proof.afterRestart = {
        closed: {
          previousBackendSessionId: closed.backendSessionId,
          backendSessionId: closedRestart.backendSessionId,
          sameBackendSession: closedRestart.backendSessionId === closed.backendSessionId,
          history: afterClosed.history,
        },
        kept: {
          previousBackendSessionId: kept.backendSessionId,
          backendSessionId: keptRestart.backendSessionId,
          sameBackendSession: keptRestart.backendSessionId === kept.backendSessionId,
          history: afterKept.history,
        },
        store: await snapshotStore(state.root),
        fixture: await fixtureHistories(peerDir),
      };

      expect(closedRestart.backendSessionId).not.toBe(closed.backendSessionId);
      expect(afterClosed.history).toEqual(["after"]);
      expect(keptRestart.backendSessionId).toBe(kept.backendSessionId);
      expect(afterKept.history).toEqual(["kept-before", "kept-reopen", "kept-after"]);
      const legacyAfter = (
        proof.afterRestart as {
          store: Array<{
            acpx_record_id: string;
            sha256: string;
            reset_on_next_ensure: boolean | null;
          }>;
        }
      ).store.find((row) => row.acpx_record_id === legacyKey);
      expect(legacyAfter?.sha256).toBe(legacyHash);
      expect(legacyAfter?.reset_on_next_ensure ?? null).toBeNull();
      const keptAfterStore = (
        proof.afterRestart as {
          store: Array<{ acpx_record_id: string; reset_on_next_ensure: boolean | null }>;
        }
      ).store.find((row) => row.acpx_record_id === keptKey);
      expect(keptAfterStore?.reset_on_next_ensure ?? null).not.toBe(true);
    } finally {
      await stopBackend(started);
      process.stdout.write(`${JSON.stringify(proof)}\n`);
    }
  });
}, 90_000);
