import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { bindWorkerToolPreparation } from "../../agents/harness/host-private-capabilities.js";
import { createNativeSessionBindingAuthority } from "../../agents/harness/native-session/binding-authority.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as sessionReads from "../../config/sessions/session-entry-read-runtime.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import type {
  ReplyBackendMessageInjectionV2,
  ReplyBackendQueueMessageOptions,
} from "./reply-run-registry.contracts.js";
import { beginReplyMessageInjectionTarget, replyRunRegistry } from "./reply-run-registry.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

afterEach(() => {
  testing.resetReplyRunRegistry();
  vi.restoreAllMocks();
});

const overlay = { senderIsOwner: true, disableTools: false, traceAuthorized: false };

it.each(["worker", "compatibility"] as const)(
  "retains supplied %s source policy alongside an overlay through final native admission",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const createOperation = async (name: string) => {
        const policyKey = `agent:main:${name}-policy`;
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: policyKey },
          { sessionId: name, updatedAt: 1, sandboxMode: "off" },
        );
        const run = createQueueTestRun({ prompt: name });
        Object.assign(run.run, {
          agentId: "main",
          sessionId: name,
          sessionKey: `agent:main:${name}`,
          runtimePolicySessionKey: policyKey,
          senderIsOwner: true,
          config: {
            agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {} } },
            tools: { sandbox: { tools: { deny: ["exec"] } } },
          },
        });
        const operation = createTestReplyOperation({
          sessionKey: run.run.sessionKey,
          sessionId: name,
        });
        await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
        const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
        return { operation, fingerprint, policyKey };
      };
      const source = await createOperation("source");
      const target = await createOperation("target");
      const assertSourcePolicy = (fingerprint: string | undefined) => {
        if (fingerprint !== source.fingerprint) {
          throw new Error("source policy revoked");
        }
      };
      const sourcePreparation = {
        assertCurrent: vi.fn(),
        prepareCurrent: vi.fn(async () =>
          assertSourcePolicy(await source.operation.projectToolAuthorityFingerprintAsync(overlay)),
        ),
        compatAssertCurrent: vi.fn(() =>
          assertSourcePolicy(source.operation.projectToolAuthorityFingerprint(overlay)),
        ),
      };
      if (kind === "worker") {
        bindWorkerToolPreparation(sourcePreparation);
      }
      const authority = createNativeSessionBindingAuthority([], () => {});
      const effect = vi.fn();
      target.operation.attachBackend({
        kind: "embedded",
        cancel() {},
        toolAuthorityFingerprint: target.fingerprint,
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          async queueMessage() {
            throw new Error("Expected the prepared companion");
          },
          queueMessageAsync: async (_text, options, preparation) =>
            authority.withPreparedCurrent!(() => {
              effect();
              options?.onQueueAccepted?.(true);
            }, [preparation]),
        },
      });
      target.operation.setPhase("running");
      const entered = createDeferred();
      const resume = createDeferred();
      const read = sessionReads.withSessionEntriesFromStoresInWorker;
      const delayed = vi
        .spyOn(sessionReads, "withSessionEntriesFromStoresInWorker")
        .mockImplementation(async (inputs, consume, options) => {
          if (options?.ordered) {
            entered.resolve();
            await resume.promise;
          }
          return read(inputs, consume, options);
        });
      const calls = kind === "worker" ? observeMainThreadSql() : undefined;
      let attempt: Awaited<ReturnType<typeof beginReplyMessageInjectionTarget>> | undefined;
      try {
        attempt = await beginReplyMessageInjectionTarget(
          replyRunRegistry.resolveCurrentMessageInjectionTarget(target.operation.key)!,
          "overlay with retained source",
          {
            isInboundUserMessage: true,
            toolAuthorityOverlay: overlay,
            toolAuthorityPreparation: sourcePreparation,
          },
        );
        await awaitGateBeforeSettlement(
          entered.promise,
          attempt.outcome,
          "Native admission was not reached",
        );
        calls?.expectIdle();
        const foreign = new DatabaseSync(
          resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        );
        try {
          foreign
            .prepare(
              "UPDATE session_nodes SET entry_json = json_remove(entry_json, '$.sandboxMode') WHERE session_key = ?",
            )
            .run(source.policyKey);
        } finally {
          foreign.close();
        }
        calls?.clear();
        resume.resolve();
        expect((await attempt.outcome).status).toBe(kind === "worker" ? "rejected" : "failed");
        await expect(attempt.acceptance).resolves.toBe(false);
        expect(effect).not.toHaveBeenCalled();
        expect(sourcePreparation.compatAssertCurrent).toHaveBeenCalledTimes(
          kind === "worker" ? 0 : 1,
        );
        calls?.expectIdle();
      } finally {
        resume.resolve();
        await attempt?.outcome;
        calls?.restore();
        delayed.mockRestore();
      }
    });
  },
);

it.each(["source-only", "with-overlay", "separate-caller", "legacy"] as const)(
  "keeps every supplied authority through final admission: %s",
  async (kind) => {
    const operation = createTestReplyOperation();
    operation.bindToolAuthoritySnapshot({ fingerprint: () => "policy", project: () => "policy" });
    operation.bindToolAuthorityRoute({ provider: "test", model: "test" });
    const entered = createDeferred();
    const resume = createDeferred();
    const effect = vi.fn(async () => {});
    const source = { current: true };
    const assertSource = () => {
      if (!source.current) {
        throw new Error("source owner revoked");
      }
    };
    operation.attachBackend({
      kind: "embedded",
      cancel() {},
      toolAuthorityFingerprint: "policy",
      ...(kind === "legacy"
        ? { messageInjection: { isAvailable: () => true, queueMessage: effect } }
        : {
            messageInjectionV2: {
              version: 2,
              isAvailable: () => true,
              queueMessage: effect,
              queueMessageAsync: async (_text, _options, preparation) => {
                entered.resolve();
                await resume.promise;
                preparation.assertCurrent();
                await effect();
              },
            } satisfies ReplyBackendMessageInjectionV2,
          }),
    });
    operation.setPhase("running");
    const attempt = await beginReplyMessageInjectionTarget(
      replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!,
      "retained source",
      {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: "policy",
        ...(kind === "with-overlay" ? { toolAuthorityOverlay: overlay } : {}),
        assertCurrent: kind === "separate-caller" ? assertSource : undefined,
        toolAuthorityPreparation: {
          assertCurrent: kind === "separate-caller" ? () => {} : assertSource,
          async prepareCurrent() {},
          compatAssertCurrent: assertSource,
        },
      },
    );
    try {
      if (kind !== "legacy") {
        await awaitGateBeforeSettlement(
          entered.promise,
          attempt.outcome,
          "Prepared backend was not reached",
        );
        source.current = false;
        resume.resolve();
      }
      await expect(attempt.outcome).resolves.toMatchObject(
        kind === "legacy"
          ? { status: "rejected", reason: "injection_unavailable" }
          : { status: "failed" },
      );
      await expect(attempt.acceptance).resolves.toBe(false);
      expect(effect).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await attempt.outcome;
    }
  },
);

it("keeps callback acceptance authoritative over later queue rejection", async () => {
  const delivery = createDeferred();
  let queueOptions: ReplyBackendQueueMessageOptions | undefined;
  const operation = createTestReplyOperation({ originatingLeafEntryId: "leaf-a" });
  operation.setPhase("running");
  operation.attachBackend({
    kind: "embedded",
    runId: "run-a",
    cancel: vi.fn(),
    messageInjection: {
      isAvailable: () => true,
      queueMessage: vi.fn((_text, options) => {
        queueOptions = options;
        return delivery.promise;
      }),
    },
  });
  const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
  const attempt = await beginReplyMessageInjectionTarget(target, "uncertain");

  queueOptions?.onQueueAccepted?.(true);
  delivery.reject(new Error("transcript unconfirmed"));

  await expect(attempt.acceptance).resolves.toBe(true);
  await expect(attempt.outcome).resolves.toMatchObject({ status: "rejected" });
});
