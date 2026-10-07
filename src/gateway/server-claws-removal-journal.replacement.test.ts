import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  GatewayProtocolRequestError,
  retainGatewayResponsePayload,
} from "../../packages/gateway-client/src/protocol-request.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { digestClawValue } from "../claws/digest.js";
import { buildClawRemovalFixture } from "../claws/lifecycle-remove.test-support.js";
import { readClawInstallRecordFromDatabase } from "../claws/provenance-read.kernel.js";
import { persistClawInstallRecord } from "../claws/provenance.js";
import { clawRemovalJournalResultSchema } from "../claws/removal-journal-contract.js";
import { clawRemovalJournalGateway } from "../cli/claws-cli.removal-journal.js";
import * as gatewayRpc from "../cli/gateway-rpc.js";
import { getRuntimeConfig, resetConfigRuntimeState } from "../config/config.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import type { AgentDeletionJournalTransport } from "../state/agent-deletion-journal-transport.js";
import * as journals from "../state/agent-deletion-journal.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { readOpenClawStateLease } from "../state/openclaw-state-lease-store.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { clawJournalReplacementEntrypoint } from "./claws-removal-journal-replacement-runtime.test-support.js";

const replySchema = z.object({
  id: z.string(),
  accepted: z.boolean().optional(),
  payload: z.unknown().optional(),
  error: z
    .object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
    .optional(),
  harnessError: z.string().optional(),
  stages: z.array(
    z.object({ stage: z.string(), elapsedMs: z.number(), nonce: z.string().optional() }),
  ),
  elapsedMs: z.number(),
});
type Reply = z.infer<typeof replySchema>;
const familySuffixes = ["", "-wal", "-shm", "-journal"] as const;
const priorOperationId = "prior-synthetic-removal";

describe("Claw journal original physical source", () => {
  let server: ChildProcess;
  let bootstrap: OpenClawTestState;
  let startupMs: number;
  let stderr = "";
  const ready = createDeferred();
  const exited = createDeferred();
  const pending = new Map<string, ReturnType<typeof createDeferred<Reply>>>();
  beforeAll(async () => {
    bootstrap = await createOpenClawTestState({ label: "claw-journal-server", applyEnv: false });
    const started = performance.now();
    server = spawn(
      process.execPath,
      resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(clawJournalReplacementEntrypoint)),
      {
        env: bootstrap.env,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    server.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16_384);
    });
    const fail = (error: Error) => {
      ready.reject(error);
      for (const request of pending.values()) {
        request.reject(error);
      }
      pending.clear();
    };
    server.on("error", fail);
    server.on("exit", (code, signal) => {
      fail(new Error(`Journal proof server exited ${code}/${signal}: ${stderr}`));
      exited.resolve();
    });
    server.on("message", (message: unknown) => {
      if (message && typeof message === "object" && "ready" in message && message.ready === true) {
        startupMs = performance.now() - started;
        ready.resolve();
        return;
      }
      const parsed = replySchema.safeParse(message);
      if (!parsed.success) {
        fail(new Error(`Invalid journal proof response: ${parsed.error.message}`));
        return;
      }
      pending.get(parsed.data.id)?.resolve(parsed.data);
      pending.delete(parsed.data.id);
    });
    await ready.promise;
  });
  afterAll(async () => {
    if (server?.connected) {
      server.disconnect();
    }
    if (server) {
      await exited.promise;
    }
    await bootstrap?.cleanup();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["before-remote-admission", "after-client-preassert"] as const)(
    "does not mutate an identical replacement %s",
    async (cut) => {
      await withOpenClawTestState({ label: `claw-journal-${cut}` }, async (state) => {
        const { plan } = await buildClawRemovalFixture(state.root);
        await state.writeConfig({
          agents: { entries: { worker: { workspace: plan.agent.workspace } } },
        });
        resetConfigRuntimeState();
        const install = persistClawInstallRecord(plan);
        const config = getRuntimeConfig();
        const configBytes = readFileSync(state.configPath);
        journals.beginAgentDeletionJournal({
          agentId: "worker",
          operationId: priorOperationId,
          agentDir: state.agentDir("worker"),
          workspaceDir: plan.agent.workspace,
          sessionsDir: state.sessionsDir("worker"),
          deleteFiles: false,
        });
        const database = openOpenClawStateDatabase();
        const pathname = database.path;
        const replacement = state.path("replacement.sqlite");
        const retained = state.path("original.sqlite");
        const originalIdentity = readDatabasePathIdentitySync(pathname);
        const moved: string[] = [];
        let swapped = false;
        let swappedAt = 0;
        let reply: Reply | undefined;
        let elapsedMs = 0;
        let armReadSwap = false;
        const swap = () => {
          if (swapped) {
            throw new Error("Replacement proof attempted a second swap");
          }
          for (const suffix of familySuffixes) {
            if (existsSync(`${pathname}${suffix}`)) {
              renameSync(`${pathname}${suffix}`, `${retained}${suffix}`);
              moved.push(suffix);
            }
          }
          renameSync(replacement, pathname);
          swapped = true;
          swappedAt = performance.now();
        };
        const realReadJournal = journals.readAgentDeletionJournal;
        vi.spyOn(journals, "readAgentDeletionJournal").mockImplementation((...args) => {
          const journal = realReadJournal(...args);
          if (armReadSwap) {
            armReadSwap = false;
            swap();
          }
          return journal;
        });
        vi.spyOn(gatewayRpc, "callGatewayFromCli").mockImplementation(
          async (method, _options, params) => {
            if (method !== "claws.removalJournal") {
              throw new Error("Unexpected proof transport method");
            }
            if (cut === "after-client-preassert") {
              swap();
            }
            const response = createDeferred<Reply>();
            pending.set(cut, response);
            server.send(
              {
                id: cut,
                params,
                stateDir: state.stateDir,
                configPath: state.configPath,
                home: state.home,
              },
              (error) => {
                if (error) {
                  pending.delete(cut);
                  response.reject(error);
                }
              },
            );
            reply = await response.promise;
            elapsedMs = performance.now() - swappedAt;
            if (reply.harnessError) {
              throw new Error(reply.harnessError);
            }
            if (!reply.accepted) {
              const error = new GatewayProtocolRequestError(
                reply.error ?? { message: "Missing Gateway refusal" },
              );
              retainGatewayResponsePayload(error, reply.payload);
              throw error;
            }
            return clawRemovalJournalResultSchema.parse(reply.payload);
          },
        );
        const journalTransport: AgentDeletionJournalTransport = (mutation, authority) =>
          clawRemovalJournalGateway(
            {
              ...mutation,
              expectedInstallDigest: digestClawValue(install),
              configDigest: digestClawValue(config),
            },
            authority,
          );
        const snapshot = (db: DatabaseSync) => ({
          lease: readOpenClawStateLease(db, { scope: "core:agent-deletion", key: "worker" }),
          journal: journals.readAgentDeletionJournalInDatabase({ db }, "worker"),
          install: readClawInstallRecordFromDatabase(db, "worker"),
        });
        let outcome: unknown;
        try {
          outcome = await withAgentDeletion(
            "worker",
            async (begin) => {
              // The real lease and its heartbeat remain live throughout backup and the request.
              const originalFacts = snapshot(database.db);
              await backup(database.db, replacement);
              const copied = new DatabaseSync(replacement, { readOnly: true });
              try {
                expect(snapshot(copied)).toEqual(originalFacts);
              } finally {
                copied.close();
              }
              expect(originalFacts.lease).toBeDefined();
              armReadSwap = cut === "before-remote-admission";
              return await begin({
                agentId: "worker",
                agentDir: state.agentDir("worker"),
                workspaceDir: plan.agent.workspace,
                sessionsDir: state.sessionsDir("worker"),
                deleteFiles: false,
              });
            },
            { journalTransport },
          ).catch((error: unknown) => error);
          const replacementIdentity = readDatabasePathIdentitySync(pathname);
          const observed = new DatabaseSync(pathname, { readOnly: true });
          let durableOperationId: string | undefined;
          try {
            durableOperationId = journals.readAgentDeletionJournalInDatabase(
              { db: observed },
              "worker",
            )?.operationId;
          } finally {
            observed.close();
          }
          console.info(
            "claw-journal-replacement-evidence",
            JSON.stringify({
              cut,
              startupMs,
              elapsedMs: elapsedMs || performance.now() - swappedAt,
              originalIdentity,
              replacementIdentity,
              durableOperationId,
              server: reply,
              outcome: String(outcome),
            }),
          );
          // This must fail first on the vulnerable control: its native writer replaces the copied journal.
          expect(durableOperationId).toBe(priorOperationId);
          expect(swapped).toBe(true);
          expect(replacementIdentity.key).not.toBe(originalIdentity.key);
          expect(readFileSync(state.configPath)).toEqual(configBytes);
          expect(outcome).toBeInstanceOf(Error);
          expect(String(outcome)).toMatch(/identity|source|generation|ownership|unknown/i);
          if (cut === "after-client-preassert") {
            expect(reply?.harnessError).toBeUndefined();
            expect(reply?.accepted).toBe(false);
          }
        } finally {
          armReadSwap = false;
          // Both the original operation and the server's worker settlement precede restoration.
          if (swapped) {
            for (const suffix of familySuffixes) {
              if (existsSync(`${pathname}${suffix}`)) {
                renameSync(`${pathname}${suffix}`, `${replacement}${suffix}`);
              }
            }
            for (const suffix of moved) {
              renameSync(`${retained}${suffix}`, `${pathname}${suffix}`);
            }
          }
        }
      });
    },
  );
});
