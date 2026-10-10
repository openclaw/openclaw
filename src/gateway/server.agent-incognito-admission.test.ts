import "./test-helpers.mocks.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import * as acpMetadata from "../acp/runtime/session-meta.js";
import * as preparedRuntime from "../agents/prepared-model-runtime.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import { openIncognitoTestActor } from "../state/openclaw-agent-execution-incognito.test-support.js";
import * as preflight from "./agent-turn/agent-request-preflight.js";
import * as operatorRun from "./operator-run-cancellation.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import { agentRunHandler } from "./server-methods/agent-run-handler.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  installAgentAuthorityProofFixture,
  PNG,
} from "./server.agent-runtime-authority-proof.test-support.js";
import { agentCommandMock } from "./test-helpers.js";

const authority = { assertCurrent() {} };

describe("bound incognito agent admission", () => {
  const fixture = installAgentAuthorityProofFixture();

  afterEach(async () => {
    await closeSkillsWatchers(true);
  });

  it.each(["public", "internal", "create", "id", "retry"] as const)(
    "admits %s through the recorder with configured roles",
    async (route) => {
      const f = await fixture({ imageCapable: true });
      const actor = await openIncognitoTestActor(process.env, authority);
      const runId = randomUUID();
      const sessionKey = `agent:main:dashboard:incognito-${runId}`;
      if (route !== "create")
        await actor.sessions.create(authority, {
          sessionKey,
          entry: { sessionId: runId, updatedAt: Date.now(), incognito: true },
        });
      const base = f.context.getRuntimeConfig();
      const cfg: OpenClawConfig = {
        ...base,
        gateway: {
          ...base.gateway,
          roles: {
            default: "writer",
            definitions: {
              writer: {
                agents: ["main"],
                scopes: ["operator.admin"],
                sessions: { others: "write" },
              },
            },
          },
        },
      };
      const config = vi.spyOn(f.context, "getRuntimeConfig").mockReturnValue(cfg);
      const message = `record ${route}`;
      const client = createOperatorClient({
        profileName: `incognito-${route}`,
        scopes: ["operator.admin"],
      });
      agentCommandMock.mockImplementation(async (options) => {
        await options.userTurnTranscriptRecorder?.persistApproved();
        return { payloads: [{ text: "recorded" }], meta: { durationMs: 1 } };
      });
      const sql = observeHostDataSql();
      try {
        await withIncognitoSessionActor(actor, async () => {
          const request = {
            message,
            ...(route === "id" ? { sessionKey: undefined, sessionId: runId } : { sessionKey }),
            idempotencyKey: runId,
          };
          if (route === "retry") {
            const read = vi
              .spyOn(actor.sessions, "read")
              .mockRejectedValueOnce(new Error("routing read unavailable"));
            try {
              await expect(
                agentRunHandler({
                  req: { type: "req", id: runId, method: "agent", params: request },
                  params: request,
                  context: f.context,
                  client,
                  respond: vi.fn(),
                  isWebchatConnect: () => false,
                }),
              ).rejects.toThrow("routing read unavailable");
              expect(f.context.dedupe.has(`agent:${runId}`)).toBe(false);
            } finally {
              read.mockRestore();
            }
          }
          const response =
            route === "internal"
              ? await (
                  await f.context.createAgentTurnFacade!({ client })
                ).dispatchRaw(request, { expectFinal: true })
              : await dispatchGatewayRequestInProcessRaw("agent", request, {
                  client,
                  context: f.context,
                  expectFinal: true,
                });
          expect(response, response.error?.message).toMatchObject({ ok: true });
          await f.drain();
          expect(agentCommandMock).toHaveBeenCalledTimes(1);
          const entry = (await actor.sessions.read(authority, { sessionKey })).entry;
          expect(entry?.sessionId).toBeTruthy();
          expect(
            await actor.sessions.history(authority, {
              type: "session.history.message-presence",
              input: {
                sessionKey,
                sessionId: entry!.sessionId,
                lifecycleRevision: entry!.lifecycleRevision,
              },
            }),
          ).toBe(true);
        });
        expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
      } finally {
        sql.restore();
        config.mockRestore();
        await f.cleanup();
        await actor.close();
      }
    },
  );

  it.each(["preflight", "attachments", "model", "acceptance"] as const)(
    "refuses a revoked public caller after %s preparation",
    async (stage) => {
      const f = await fixture(stage === "attachments" ? { imageCapable: true } : undefined);
      const actor = await openIncognitoTestActor(process.env, authority);
      const runId = randomUUID();
      const sessionKey = `agent:main:dashboard:incognito-${runId}`;
      await actor.sessions.create(authority, {
        sessionKey,
        entry: { sessionId: runId, updatedAt: Date.now(), incognito: true },
      });
      const entered = createDeferred();
      const release = createDeferred();
      const hold = async <T>(value: T) => {
        entered.resolve();
        await release.promise;
        return value;
      };
      const originals = {
        preflight: preflight.prepareAgentRequestPreflight,
        attachments: acpMetadata.readAcpSessionEntryAsync,
        model: preparedRuntime.loadPublishedGatewayReplyDispatchRuntime,
        acceptance: operatorRun.retainGatewayOperatorRun,
      };
      const observer =
        stage === "preflight"
          ? vi.spyOn(preflight, "prepareAgentRequestPreflight").mockImplementation(
              (() => {
                const original = originals.preflight;
                return async (...args: Parameters<typeof original>) =>
                  hold(await original(...args));
              })(),
            )
          : stage === "attachments"
            ? vi.spyOn(acpMetadata, "readAcpSessionEntryAsync").mockImplementation(
                (() => {
                  const original = originals.attachments;
                  return async (...args: Parameters<typeof original>) =>
                    hold(await original(...args));
                })(),
              )
            : stage === "model"
              ? vi
                  .spyOn(preparedRuntime, "loadPublishedGatewayReplyDispatchRuntime")
                  .mockImplementation(
                    (() => {
                      const original = originals.model;
                      return async (...args: Parameters<typeof original>) =>
                        hold(await original(...args));
                    })(),
                  )
              : vi.spyOn(operatorRun, "retainGatewayOperatorRun").mockImplementation(
                  (() => {
                    const original = originals.acceptance;
                    return async (...args: Parameters<typeof original>) =>
                      hold(await original(...args));
                  })(),
                );
      let request: ReturnType<typeof f.dispatch> | undefined;
      try {
        request = withIncognitoSessionActor(actor, () =>
          f.dispatch({
            message: "must not execute",
            sessionKey,
            idempotencyKey: runId,
            ...(stage === "attachments"
              ? { attachments: [{ mimeType: "image/png", fileName: "proof.png", content: PNG }] }
              : {}),
          }),
        );
        await awaitGateBeforeSettlement(
          entered.promise,
          request,
          `agent skipped ${stage} preparation`,
        );
        f.owner.revoke();
        release.resolve();
        const result = await request;
        await f.drain();
        expect(result.ok).toBe(false);
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled(request ? [request] : []);
        observer.mockRestore();
        await f.cleanup();
        await actor.close();
      }
    },
  );
});
