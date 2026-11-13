import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertAuthProfileAsync } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, expect, it, vi } from "vitest";
import {
  executeGoogleResearch,
  GoogleResearchError,
  type GoogleResearchContext,
  type GoogleResearchHandle,
  type GoogleResearchSnapshot,
} from "../extensions/google/api.js";
import { clearRuntimeConfigSnapshot } from "../src/config/config.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../src/secrets/runtime.js";

const live =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_RESEARCH_ACCEPTANCE === "1";
const profileId = "google:research-live";
const terminal = new Set(["completed", "partial", "failed", "cancelled"]);
afterEach(() => {
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it.skipIf(!live)(
  "retains one real Google research handle through poll and cancellation",
  { timeout: 300_000 },
  async () => {
    const deadlineSignal = AbortSignal.timeout(240_000);
    const keyName = process.env.GOOGLE_API_KEY
      ? "GOOGLE_API_KEY"
      : process.env.GEMINI_API_KEY
        ? "GEMINI_API_KEY"
        : undefined;
    if (!keyName) {
      throw new Error("Google API-key owner unavailable");
    }
    // This private, task-owned receipt survives failed normalization or cleanup.
    // Never put a provider key in the receipt or create another paid start on retry.
    const root = path.resolve(".crabbox/runs/research-acceptance");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    const agentDir = path.join(root, "state/agents/researcher/agent");
    await fs.mkdir(agentDir, { recursive: true });
    await upsertAuthProfileAsync({
      profileId,
      agentDir,
      credential: {
        type: "api_key",
        provider: "google",
        keyRef: { source: "env", provider: "default", id: keyName },
      },
    });
    const config: OpenClawConfig = {
      auth: { profiles: { [profileId]: { provider: "google", mode: "api_key" } } },
    };
    activateSecretsRuntimeSnapshot(
      await prepareSecretsRuntimeSnapshot({
        config,
        agentDirs: [agentDir],
        includeConfigRefs: false,
      }),
    );
    // One-shot acceptance custody; this is not a new product state owner.
    const db = new DatabaseSync(path.join(root, "google.sqlite"));
    db.exec(
      "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS receipt (id INTEGER PRIMARY KEY CHECK(id=1), account TEXT, handle TEXT, state TEXT NOT NULL)",
    );
    const read = () =>
      db.prepare("SELECT account, handle, state FROM receipt WHERE id=1").get() as
        | { account: string | null; handle: string | null; state: string }
        | undefined;
    const previous = read();
    let acceptedHandle: GoogleResearchHandle | undefined = previous?.handle
      ? (JSON.parse(previous.handle) as GoogleResearchHandle)
      : undefined;
    let selectedAccount = previous?.account;
    let persistenceFailure: unknown;
    const retainHandle = (handle: GoogleResearchHandle, strict: boolean) => {
      if (acceptedHandle && JSON.stringify(acceptedHandle) !== JSON.stringify(handle)) {
        throw new Error("Research handle changed");
      }
      acceptedHandle = handle;
      try {
        db.prepare("UPDATE receipt SET handle=? WHERE id=1").run(JSON.stringify(handle));
      } catch (error) {
        persistenceFailure ??= error;
        if (strict) {
          throw error;
        }
      }
    };
    let polled = false;
    let cancelRequested: boolean;
    const context: GoogleResearchContext = {
      api: createTestPluginApi({
        config,
        runtime: createPluginRuntimeMock({ agent: { resolveAgentDir: () => agentDir } }),
      }),
      agentId: "researcher",
      signal: AbortSignal.any([deadlineSignal, AbortSignal.timeout(60_000)]),
      assertCurrent() {},
      prepareAccount: async (account) => {
        if (selectedAccount && selectedAccount !== account) {
          throw new Error("Research account changed");
        }
        if (!selectedAccount) {
          db.prepare("UPDATE receipt SET account=? WHERE id=1").run(account);
          selectedAccount = account;
        }
      },
      recordReceipt: async (handle) => retainHandle(handle, true),
    };
    const run = async (action: "poll" | "cancel") => {
      const selected = acceptedHandle;
      if (!selected) {
        throw new Error("No retained Google handle; start must not be repeated");
      }
      const value = await executeGoogleResearch(
        { action, handle: selected },
        {
          ...context,
          signal: AbortSignal.any([deadlineSignal, AbortSignal.timeout(30_000)]),
          recordReceipt: async (handle) => retainHandle(handle, false),
        },
      );
      if (!("state" in value)) {
        throw new Error("Expected Google research snapshot");
      }
      try {
        db.prepare("UPDATE receipt SET state=? WHERE id=1").run(value.state);
      } catch (error) {
        persistenceFailure ??= error;
      }
      return value;
    };
    let failure: Error | undefined;
    try {
      if (!previous || previous.state === "not-sent") {
        const claim = db
          .prepare(
            "INSERT INTO receipt (id,state) VALUES (1,'start-intent') ON CONFLICT(id) DO UPDATE SET state='start-intent' WHERE receipt.state='not-sent' AND receipt.handle IS NULL",
          )
          .run();
        if (claim.changes !== 1) {
          throw new Error("Google start intent was not acquired; do not repeat");
        }
        try {
          const value = await executeGoogleResearch(
            {
              action: "start",
              profileId,
              question:
                "Find the official HTTP status code for a successful HTTP GET. Return a one-sentence answer with an official source.",
            },
            context,
          );
          if (!("state" in value)) {
            throw new Error("Expected Google research snapshot");
          }
          expect(acceptedHandle?.interactionId).toBe(value.handle.interactionId);
          db.prepare("UPDATE receipt SET state=? WHERE id=1").run(value.state);
        } catch (error) {
          failure = toErrorObject(error, "Google research start failed");
          if (error instanceof GoogleResearchError && error.handle) {
            retainHandle(error.handle, false);
          }
          if (
            error instanceof GoogleResearchError &&
            error.state === "blocked" &&
            error.httpStatus === undefined &&
            !acceptedHandle
          ) {
            // The adapter's blocked/no-HTTP contract proves dispatch did not begin.
            const reconciled = db
              .prepare(
                "UPDATE receipt SET state='not-sent' WHERE id=1 AND state='start-intent' AND handle IS NULL",
              )
              .run();
            if (reconciled.changes !== 1) {
              // oxlint-disable-next-line preserve-caught-error -- Provider payloads can contain confidential handles.
              throw new Error("Google not-sent receipt reconciliation failed");
            }
          }
        }
      }
      if (acceptedHandle) {
        try {
          await run("poll");
          polled = true;
        } catch (error) {
          failure ??= toErrorObject(error, "Google research poll failed");
        }
        try {
          await run("cancel");
          cancelRequested = true;
        } catch (error) {
          // A completed interaction can reject cancellation. An actual HTTP
          // response plus the later terminal GET still proves the race safely.
          cancelRequested = error instanceof GoogleResearchError && error.httpStatus !== undefined;
          if (!cancelRequested) {
            failure ??= toErrorObject(error, "Google research cancellation failed");
          }
        }
        let final: GoogleResearchSnapshot | undefined;
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            final = await run("poll");
            if (terminal.has(final.state)) {
              break;
            }
          } catch (error) {
            failure ??= toErrorObject(error, "Google research cleanup poll failed");
          }
          if (attempt < 5) {
            await delay(5_000, undefined, { signal: deadlineSignal });
          }
        }
        if (!final || !terminal.has(final.state)) {
          throw new Error(
            "Google research cleanup remains nonterminal; retained receipt must be reconciled",
          );
        }
        if (persistenceFailure) {
          throw new Error("Google receipt persistence failed; same-handle cleanup was attempted");
        }
        if (failure) {
          throw failure;
        }
        expect(polled).toBe(true);
        expect(cancelRequested).toBe(true);
        console.log(
          JSON.stringify({
            proof: "research-google",
            acceptedHandlePersisted: true,
            sameAccount: true,
            polled,
            cancelRequested,
            terminal: final.state,
          }),
        );
      } else {
        throw failure ?? new Error("Google start outcome uncertain; do not repeat");
      }
    } catch (error) {
      if (error instanceof GoogleResearchError) {
        // oxlint-disable-next-line preserve-caught-error -- Provider errors can contain confidential handles and response payloads.
        throw new Error(
          `Google acceptance ${error.state}; HTTP ${error.httpStatus ?? "unavailable"}; retainedHandle=${Boolean(acceptedHandle)}`,
        );
      }
      throw error;
    } finally {
      db.close();
    }
  },
);
