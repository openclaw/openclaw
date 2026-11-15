import { setTimeout as nextPublicationWindow } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import * as transcriptResources from "../config/sessions/session-transcript-worker-resources.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createAgentCreationWitnessSource } from "../state/openclaw-agent-execution.creation-fixture.test-support.js";
import * as agentExecution from "../state/openclaw-agent-execution.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  captureClientVoiceEntrySource,
  captureClientVoiceSessionSourceOptions,
  captureClientVoiceSessionWriter,
} from "./client-voice-session-source.js";
import { ensureClientVoiceAgentSessionEntry } from "./client-voice-session-write.js";
import { seedSession } from "./client-voice-session.fixture.test-support.js";

const { useClientVoiceSessionHarness } = await vi.hoisted(
  () => import("./client-voice-session.harness.test-support.js"),
);

describe("Talk entry source preparation", () => {
  useClientVoiceSessionHarness();
  const target = { agentId: "main", sessionKey: "agent:main:main" };

  it.each(["metadata", "entry"] as const)(
    "joins pending agent initialization when capturing the Talk %s writer",
    async (kind) => {
      const options = captureClientVoiceSessionSourceOptions(target.agentId);
      openOpenClawStateDatabase({ env: options.env });
      const creator = agentExecution.captureOpenClawAgentDatabaseExecution(options);
      let operation: Promise<unknown> | undefined;
      let release: (() => Promise<void>) | undefined;
      const source = createAgentCreationWitnessSource((request) => {
        const facts = request.facts;
        if (
          !operation &&
          request.stage === "prepare" &&
          facts !== null &&
          typeof facts === "object" &&
          "kind" in facts &&
          facts.kind === "shared-owner"
        ) {
          operation = (async () => {
            if (kind === "metadata") {
              const writer = captureClientVoiceSessionWriter(target);
              release = () => writer.release();
              return writer.mutate({
                ...target,
                kind: "create",
                voiceSessionId: "voice-pending-agent",
                origin: "client",
                now: 1,
              });
            }
            const selected = await captureClientVoiceEntrySource(target, () => {});
            release = () => selected.execution.release();
            await selected.execution.prepare(source);
            return selected.execution.runExisting(source, (worker) =>
              worker.execute({
                type: "session.transcript.initialize",
                input: { sessionKey: target.sessionKey, sessionId: "voice-entry" },
              }),
            );
          })();
          void operation.catch(() => {});
        }
      });
      try {
        await creator.prepare(source);
        expect(operation).toBeDefined();
        await expect(operation).resolves.toMatchObject(
          kind === "metadata"
            ? { voiceSessionId: "voice-pending-agent", status: "open" }
            : { kind: "session-transcript-initialized", sessionKey: target.sessionKey },
        );
      } finally {
        await operation?.catch(() => {});
        await release?.();
        await creator.release();
      }
    },
  );

  it("keeps entry discovery ahead of a later canonical writer", async () => {
    await seedSession(target.sessionKey);
    await ensureClientVoiceAgentSessionEntry({
      ...target,
      sessionKey: "agent:main:selector-warmup",
    });
    const canonical = resolveOpenClawAgentSqlitePath(target);
    const storePath = canonical;
    const gate = createEnteredGate();
    const prepare = transcriptResources.prepareSessionStoreCandidatesInWorker;
    let held = false;
    const discovery = vi
      .spyOn(transcriptResources, "prepareSessionStoreCandidatesInWorker")
      .mockImplementation(async (request) => {
        const result = await prepare(request);
        if (!held && "write" in request && request.write.storePath === storePath) {
          held = true;
          await gate.wait();
        }
        return result;
      });
    const published: string[] = [];
    const first = ensureClientVoiceAgentSessionEntry({
      ...target,
      storePath,
      sessionKey: "agent:main:selector-first",
      onCommitted: () => {
        published.push("first");
      },
    });
    void first.catch(() => {});
    let second: Promise<string> | undefined;
    try {
      await gate.entered;
      second = ensureClientVoiceAgentSessionEntry({
        ...target,
        storePath: canonical,
        sessionKey: "agent:main:selector-second",
        onCommitted: () => {
          published.push("second");
        },
      });
      void second.catch(() => {});
      // Discovery is held while the later writer has a publication opportunity.
      await nextPublicationWindow(100);
      gate.release();
      await Promise.all([first, second]);
      expect(published).toEqual(["first", "second"]);
    } finally {
      gate.release();
      await Promise.allSettled([first, second]);
      discovery.mockRestore();
    }
  });
});
