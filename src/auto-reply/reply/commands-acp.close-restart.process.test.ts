import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRegistry, createFileSessionStore } from "acpx/runtime";
import { expect, it } from "vitest";
import { AcpxRuntime } from "../../../extensions/acpx/src/runtime.js";
import {
  disposeAcpSessionManager,
  getAcpSessionManager,
  testing as managerTesting,
  type AcpSessionManager,
} from "../../acp/control-plane/manager.js";
import {
  registerAcpRuntimeBackend,
  testing as registryTesting,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
  for (const name of names.sort()) {
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
      acpx_keys: parsed.acpx ? Object.keys(parsed.acpx).sort() : [],
    });
  }
  return rows;
}

async function fixtureHistories(directory: string) {
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const rows = [];
  for (const name of names) {
    const parsed = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as {
      history?: string[];
    };
    rows.push({ file: name, history: parsed.history ?? null });
  }
  return rows;
}

function startBackend(stateRoot: string, peerDir: string) {
  registryTesting.resetAcpRuntimeBackendsForTests();
  managerTesting.resetAcpSessionManagerForTests();
  const runtime = new AcpxRuntime({
    cwd: stateRoot,
    sessionStore: createFileSessionStore({ stateDir: stateRoot }),
    agentRegistry: createAgentRegistry({
      overrides: { fixture: [process.execPath, peer, peerDir] },
    }),
    permissionMode: "deny-all",
    timeoutMs: 5_000,
  });
  registerAcpRuntimeBackend({ id: "acpx", runtime });
  return { runtime, manager: getAcpSessionManager() };
}

async function stopBackend(runtime: AcpxRuntime | undefined): Promise<void> {
  await disposeAcpSessionManager("proof-restart");
  managerTesting.resetAcpSessionManagerForTests();
  unregisterAcpRuntimeBackend("acpx");
  await runtime?.shutdown();
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
    const runtimes: AcpxRuntime[] = [];
    try {
      const first = startBackend(state.root, peerDir);
      runtimes.push(first.runtime);
      const closed = await openSession(first.manager, closedKey, state.root);
      const kept = await openSession(first.manager, keptKey, state.root);
      const beforeClosed = await prompt(first.manager, closedKey, "before");
      const beforeKept = await prompt(first.manager, keptKey, "kept-before");
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
      await stopBackend(first.runtime);

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

      const reopened = startBackend(state.root, peerDir);
      runtimes.push(reopened.runtime);
      const keptAgain = await openSession(reopened.manager, keptKey, state.root);
      const keptReopen = await prompt(reopened.manager, keptKey, "kept-reopen");
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
      await stopBackend(reopened.runtime);

      const restarted = startBackend(state.root, peerDir);
      runtimes.push(restarted.runtime);
      const closedRestart = await openSession(restarted.manager, closedKey, state.root);
      const afterClosed = await prompt(restarted.manager, closedKey, "after");
      const keptRestart = await openSession(restarted.manager, keptKey, state.root);
      const afterKept = await prompt(restarted.manager, keptKey, "kept-after");
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
      await Promise.allSettled(runtimes.map((runtime) => stopBackend(runtime)));
      process.stdout.write(`${JSON.stringify(proof)}\n`);
    }
  });
}, 90_000);
