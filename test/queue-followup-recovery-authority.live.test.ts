// Production-boundary proof that restore fail-closes a durable follow-up before
// any model, tool, or reply I/O once the live session's authority is tightened.
//
// This runs a real Gateway process built from this branch against an isolated
// state directory. The durable row is seeded through the production SQLite owner
// (`replaceFollowupQueueEntries`) rather than by racing a live send: a follow-up
// only reaches the durable queue while a prior turn is still in flight, and the
// Gateway exposes no signal for that instant, so racing it makes the proof
// flaky without making it stronger. Everything after the seed is the real path —
// the Gateway's own startup restore, its revalidation against the live session
// entry, and its fail-closed drop.
//
// The companion case — a restored turn completing through real execution and
// delivery — is not covered here; see "Remaining proof gap" in the PR body.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../packages/gateway-protocol/src/client-info.js";
import { isLiveTestEnabled, logLiveProgress } from "../src/agents/live-test-helpers.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../src/config/sessions/session-accessor.js";
import type { GatewayClient } from "../src/gateway/client.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { replaceFollowupQueueEntries } from "../src/infra/followup-queue-sqlite.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const MODEL_REF =
  process.env.OPENCLAW_LIVE_LOCAL_MODEL?.trim() ?? "ollama/qwen3.6:35b-a3b-q4-192k-b256";
const MODEL_ID = MODEL_REF.replace(/^[^/]+\//, "");
const OLLAMA_BASE_URL = process.env.OPENCLAW_LIVE_OLLAMA_URL?.trim() ?? "http://127.0.0.1:11434";
const MODEL_PROVIDER = MODEL_REF.includes("/")
  ? MODEL_REF.slice(0, MODEL_REF.indexOf("/"))
  : "ollama";
const SEEDED_SESSION_ID = "followup-authority-live-seed";
const SESSION_KEY = "agent:main:followup-authority-live";
const REJECTED_MARKER = "FOLLOWUP-MUST-NOT-RUN";
const FAIL_CLOSE_LOG = /session permission or tool overrides changed while the turn waited/i;
const ARTIFACT_DIR = process.env.OPENCLAW_LIVE_ARTIFACT_DIR ?? "/tmp";

function durableQueueRows(instance: OpenClawTestInstance): { queueKey: string; data: string }[] {
  const dbPath = instance.state.statePath("state", "openclaw.sqlite");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db
      .prepare(
        "SELECT queue_key AS queueKey, queue_json AS data FROM followup_queue_entries ORDER BY queue_key",
      )
      .all() as { queueKey: string; data: string }[];
  } catch (err) {
    // Before the first durable write the table does not exist yet; that is the
    // only read failure this proof may treat as "no rows". Anything else (a
    // renamed column, a corrupt file) must fail the proof instead of quietly
    // reporting an empty set that every absence assertion would pass.
    if (err instanceof Error && /no such table/i.test(err.message)) {
      return [];
    }
    throw err;
  } finally {
    db?.close();
  }
}

function sessionStorePath(instance: OpenClawTestInstance): string {
  return path.join(instance.state.sessionsDir("main"), "sessions.json");
}

async function buildInstance(): Promise<OpenClawTestInstance> {
  return await createOpenClawTestInstance({
    name: "followup-authority",
    // Real providers: a stubbed model would not prove I/O was avoided.
    env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
    config: {
      models: {
        mode: "replace",
        providers: {
          ollama: {
            baseUrl: OLLAMA_BASE_URL,
            apiKey: "ollama-local",
            api: "ollama",
            timeoutSeconds: 300,
            models: [
              {
                id: MODEL_ID,
                name: MODEL_ID,
                api: "ollama",
                input: ["text"],
                contextWindow: 131072,
                maxTokens: 131072,
                // num_ctx must equal contextWindow or the lane grinds against VRAM.
                params: { num_ctx: 131072, num_batch: 256 },
              },
            ],
          },
        },
      },
      agents: { defaults: { model: { primary: MODEL_REF } } },
      messages: { queue: { mode: "followup", debounceMs: 0 } },
    },
  });
}

async function connectAdmin(instance: OpenClawTestInstance): Promise<GatewayClient> {
  const deviceIdentity = loadOrCreateDeviceIdentity({
    path: instance.state.path(`proof-device-${Date.now()}.sqlite`),
  });
  return await acquireGatewayTestClient(
    {
      url: instance.url,
      token: instance.gatewayToken,
      deviceIdentity,
      clientName: GATEWAY_CLIENT_IDS.TEST,
      mode: "test",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: [],
    },
    {
      timeoutMs: 60_000,
      timeoutMessage: "followup authority proof Gateway connect timeout",
      closeMessage: "followup authority proof Gateway closed during connect",
    },
  );
}

/** Seeds one eligible, sender-free durable row through the production owner. */
async function seedDurableFollowup(
  instance: OpenClawTestInstance,
  permissionMode: string,
): Promise<void> {
  await replaceFollowupQueueEntries({
    stateDir: instance.state.stateDir,
    entries: [
      [
        SESSION_KEY,
        {
          items: [
            {
              prompt: REJECTED_MARKER,
              enqueuedAt: Date.now(),
              originatingChannel: "telegram",
              originatingTo: "authority-proof",
              run: {
                // `isPersistedRunFields` rejects an incomplete descriptor before
                // restore ever reaches the session-authority guard, so every one
                // of these is required for this proof to test what it claims.
                agentId: "main",
                sessionId: SEEDED_SESSION_ID,
                sessionKey: SESSION_KEY,
                sessionFile: path.join(
                  instance.state.sessionsDir("main"),
                  `${SEEDED_SESSION_ID}.jsonl`,
                ),
                workspaceDir: instance.state.workspaceDir,
                provider: MODEL_PROVIDER,
                model: MODEL_ID,
                timeoutMs: 600_000,
                blockReplyBreak: "message_end",
                permissionMode,
                sessionRoot: instance.state.workspaceDir,
                inputProvenance: { kind: "internal_system", sourceTool: "sessions.recover" },
              },
            },
          ],
          summarySources: [],
          summaryLines: [],
          summaryElisions: [],
          droppedCount: 0,
        },
      ],
    ],
  });
}

it.skipIf(!isLiveTestEnabled())(
  "fail-closes a restored follow-up before any I/O when session authority is tightened",
  { timeout: 900_000 },
  async () => {
    const evidence: Record<string, unknown> = {
      scenario: "authority-tightened-rejection-before-io",
      model: MODEL_REF,
      sessionKey: SESSION_KEY,
      failCloseReason: "session permission or tool overrides changed while the turn waited",
    };
    let instance: OpenClawTestInstance | undefined;
    let client: GatewayClient | undefined;

    await runQaGatewayFixture(
      async () => {
        instance = await buildInstance();
        await mkdir(instance.state.workspaceDir, { recursive: true });
        await instance.startGateway();
        client = await connectAdmin(instance);
        await client.request("sessions.create", {
          key: SESSION_KEY,
          agentId: "main",
          label: "Follow-up authority proof",
          model: MODEL_REF,
          permissionMode: "full",
          cwd: instance.state.workspaceDir,
        });
        await client.stopAndWait({ timeoutMs: 2_000 });
        client = undefined;
        await instance.stopGateway();

        const storePath = sessionStorePath(instance);
        const admitted = loadSessionEntryReadOnly({ storePath, sessionKey: SESSION_KEY });
        if (!admitted) {
          throw new Error("authority proof requires a live session entry to tighten");
        }
        evidence.permissionModeAtAdmission = admitted.permissionMode ?? null;

        // The queued turn carries the authority it was admitted with.
        await seedDurableFollowup(instance, admitted.permissionMode ?? "full");
        expect(durableQueueRows(instance).some((row) => row.data.includes(REJECTED_MARKER))).toBe(
          true,
        );
        evidence.durableRowSeeded = true;

        // Tighten the session while the turn waits.
        replaceSessionEntrySync(
          { storePath, sessionKey: SESSION_KEY },
          { ...admitted, permissionMode: "read-only" },
        );
        evidence.permissionModeAtRestore = "read-only";

        await instance.startGateway();
        // Startup restore must reject it; the reason is logged without the prompt.
        const logs = await (async () => {
          const deadline = Date.now() + 180_000;
          while (Date.now() < deadline) {
            const current = instance!.logs();
            if (FAIL_CLOSE_LOG.test(current)) {
              return current;
            }
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 500);
            });
          }
          return instance!.logs();
        })();
        expect(logs).toMatch(FAIL_CLOSE_LOG);
        evidence.failClosedOnTightenedAuthority = true;
        evidence.promptNotLogged = !logs.includes(REJECTED_MARKER);
        expect(evidence.promptNotLogged).toBe(true);

        // The non-delivery is durable: the row is dropped, not left runnable.
        expect(durableQueueRows(instance).some((row) => row.data.includes(REJECTED_MARKER))).toBe(
          false,
        );
        evidence.durableRowDropped = true;

        // No inference ran for the rejected turn: the local model is never called.
        evidence.noModelRunForRejectedTurn = !/model-fallback|tool-search: cataloged/.test(logs);
        evidence.gatewayLogTail = logs.slice(-4000);
        logLiveProgress("restored follow-up fail-closed before any I/O");
      },
      async () => {
        await client?.stopAndWait({ timeoutMs: 2_000 });
      },
      async () => {
        await instance?.cleanup();
      },
    );

    await writeFile(
      path.join(ARTIFACT_DIR, "followup-authority-rejection-proof.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    expect(evidence.failClosedOnTightenedAuthority).toBe(true);
    expect(evidence.durableRowDropped).toBe(true);
  },
);
