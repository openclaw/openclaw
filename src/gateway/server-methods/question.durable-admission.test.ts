import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  prepareOperatorModelPolicy,
  restoreOperatorModelPolicySnapshot,
} from "../../agents/operator-model-policy.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import * as questionStorage from "../../config/sessions/session-questions.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import * as questionChannel from "../../infra/question-channel-runtime.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOwnRunFixture } from "./question.own-run.test-support.js";
import {
  broadcast,
  callQuestionRpc,
  createQuestionTestPeer,
  installQuestionTestHooks,
  manager,
  requestParams,
} from "./question.test-support.js";

installQuestionTestHooks();
const answers = { answers: { destination: ["Library"] } };
const sessionScope = { agentId: "main", sessionKey: requestParams.sessionKey };

describe("durable RPC mutation admission", () => {
  it("refuses registration when original-store membership is revoked before native admission", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const owner = ensureProfileForEmail("membership-owner@example.test");
      const f = await createOwnRunFixture(true, false, owner.id);
      const id = "revoked-registration-membership";
      f.cfg.gateway!.roles!.definitions.guest!.scopes!.push("operator.questions");
      const runtime = {
        ...f.runtime,
        connect: { ...f.runtime.connect, scopes: ["operator.questions"] },
      };
      addSessionMember(sessionScope, { identityId: f.profile.id, addedBy: owner.id });
      let revoked = false;
      const operate = questionStorage.executeSessionQuestionOperation;
      const storageSpy = vi
        .spyOn(questionStorage, "executeSessionQuestionOperation")
        .mockImplementation(async (target, input) => {
          if (input.kind === "register" && !revoked) {
            revoked = true;
            expect(removeSessionMember(sessionScope, f.profile.id)).not.toBeNull();
          }
          return operate(target, input);
        });
      const channel = vi.spyOn(questionChannel, "handleQuestionChannelRequested");
      broadcast.mockClear();
      f.browser.socket.send.mockClear();
      try {
        expect(
          (
            await f.call(
              "question.request",
              {
                ...requestParams,
                id,
                timeoutMs: 900_000,
                durable: true,
              },
              runtime,
            )
          )[0],
        ).toBe(false);
        expect(revoked).toBe(true);
        expect(
          await operate({ ...sessionScope, assertCurrent() {} }, { kind: "get", id }),
        ).toBeUndefined();
        expect(loadSessionEntry(sessionScope)?.durableQuestionOwners).toBeUndefined();
        expect(manager.get(id)).toBeNull();
        expect(broadcast).not.toHaveBeenCalled();
        expect(channel).not.toHaveBeenCalled();
        expect(f.browser.socket.send).not.toHaveBeenCalled();
      } finally {
        storageSpy.mockRestore();
        channel.mockRestore();
        await f.close();
      }
    });
  });
  it("registers and settles captured physical custody through a symlinked state route", async () => {
    vi.useRealTimers();
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const alias = state.path("state-alias");
      fs.symlinkSync(state.stateDir, alias, process.platform === "win32" ? "junction" : "dir");
      await withEnvAsync({ OPENCLAW_STATE_DIR: alias }, async () => {
        const f = await createOwnRunFixture(true);
        try {
          expect(
            await f.call(
              "question.request",
              { ...requestParams, id: "symlink-question", timeoutMs: 900_000, durable: true },
              f.runtime,
            ),
          ).toMatchObject([true, { id: "symlink-question" }, undefined]);
          const observation = manager.observe("symlink-question")!;
          const binding = observation.sessionAccess?.durableBinding;
          if (!binding) {
            throw new Error("Expected the real prepared reader's durable binding");
          }
          expect(binding.databasePath).toBe(fs.realpathSync(binding.databasePath));
          expect(binding.storePath.startsWith(alias)).toBe(true);
          expect(broadcast).toHaveBeenCalledWith(
            "question.requested",
            expect.any(Object),
            expect.any(Object),
          );
          const scope = {
            agentId: binding.agentId,
            sessionKey: binding.sessionKey,
            storePath: binding.storePath,
            assertCurrent() {},
          };
          const committedAnswers = { answers: { destination: ["Home"] } };
          expect(
            await f.call("question.resolve", {
              id: "symlink-question",
              answers: committedAnswers,
            }),
          ).toMatchObject([true, { status: "answered", answers: committedAnswers }, undefined]);
          const owed = await questionStorage.readSessionQuestionCustody(
            binding,
            "symlink-question",
            () => {},
          );
          expect(owed).toMatchObject({
            record: { status: "answered", answers: committedAnswers },
            continuation: { status: "owed" },
          });
          if (!owed) {
            throw new Error("Expected committed question custody");
          }
          await expect(
            questionStorage.executeSessionQuestionOperation(
              { ...scope, storePath: state.statePath("forbidden.sqlite") },
              {
                kind: "claim",
                id: "symlink-question",
                expectedQuestion: owed,
                runId: "forbidden-continuation",
                gatewayEpoch: "symlink-gateway",
              },
            ),
          ).rejects.toMatchObject({ code: "question-custody-retired" });
          expect(
            await questionStorage.readSessionQuestionCustody(binding, "symlink-question", () => {}),
          ).toMatchObject({ continuation: { status: "owed" } });
          const claimed = await questionStorage.executeSessionQuestionOperation(scope, {
            kind: "claim",
            id: "symlink-question",
            expectedQuestion: owed,
            runId: "symlink-continuation",
            gatewayEpoch: "symlink-gateway",
          });
          expect(claimed).toMatchObject({ continuation: { status: "claimed" } });
          if (!claimed || Array.isArray(claimed)) {
            throw new Error("Expected claimed question custody");
          }
          expect(
            await questionStorage.executeSessionQuestionOperation(scope, {
              kind: "finish",
              id: "symlink-question",
              expectedQuestion: claimed,
              runId: "symlink-continuation",
            }),
          ).toMatchObject({ continuation: { status: "settled" } });
        } finally {
          await f.close();
        }
      });
    });
  });

  it("retains the original channel model ceiling in worker-owned question custody", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await createOwnRunFixture(true);
      const originalModels = prepareOperatorModelPolicy({
        cfg: f.cfg,
        policy: { allow: ["fixture/original"] },
        manifestPlugins: [],
      });
      const currentModels = prepareOperatorModelPolicy({
        cfg: f.cfg,
        policy: { allow: ["fixture/*"] },
        manifestPlugins: [],
      });
      const authority = createAdmittedRunOperatorAuthority({
        ...f.source.authority,
        recoverySnapshot: undefined,
        channelRecoverySource: {
          reference: { version: 1, id: "11111111-1111-4111-8111-111111111111" },
          modelPolicy: originalModels,
        },
        modelPolicy: currentModels,
      });
      const runtime = {
        ...f.runtime,
        internal: { ...f.runtime.internal, operatorRunAuthority: authority },
      };
      const id = "channel-model-ceiling";
      try {
        const response = await f.call(
          "question.request",
          { ...requestParams, id, timeoutMs: 900_000, durable: true },
          runtime,
        );
        expect(response[0], JSON.stringify(response[2])).toBe(true);
        expect(response[1]).toMatchObject({ durable: true });
        const saved = await questionStorage.executeSessionQuestionOperation(
          { ...sessionScope, assertCurrent() {} },
          { kind: "get", id },
        );
        if (!saved || Array.isArray(saved) || !saved.provenance.channelRecoverySource) {
          throw new Error("Expected committed channel question custody");
        }
        const modelPolicy = saved.provenance.channelRecoverySource.modelPolicy;
        if (!modelPolicy) {
          throw new Error("Expected the original channel model policy");
        }
        const restored = restoreOperatorModelPolicySnapshot(modelPolicy);
        expect(restored?.allows({ provider: "fixture", model: "original" })).toBe(true);
        expect(restored?.allows({ provider: "fixture", model: "broadened" })).toBe(false);
      } finally {
        await f.close();
      }
    });
  });

  it("refuses durable registration in a foreign principal's conversation without effects", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const foreign = ensureProfileForEmail("foreign-durable@example.test");
      const f = await createOwnRunFixture(true, false, foreign.id);
      const id = "foreign-registration";
      const channel = vi.spyOn(questionChannel, "handleQuestionChannelRequested");
      try {
        expect(
          (
            await f.call(
              "question.request",
              { ...requestParams, id, timeoutMs: 900_000, durable: true },
              f.runtime,
            )
          )[0],
        ).toBe(false);
        expect(
          await questionStorage.executeSessionQuestionOperation(
            { ...sessionScope, assertCurrent() {} },
            { kind: "get", id },
          ),
        ).toBeUndefined();
        expect(manager.get(id)).toBeNull();
        expect(broadcast).not.toHaveBeenCalled();
        expect(channel).not.toHaveBeenCalled();
        expect(f.browser.socket.send).not.toHaveBeenCalled();
      } finally {
        channel.mockRestore();
        await f.close();
      }
    });
  });

  it("allows the original principal's durable answer and rejects foreign or reassigned responders without effects", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const foreign = ensureProfileForEmail("foreign-durable@example.test");
      const f = await createOwnRunFixture(true);
      const id = "principal-admission";
      const params = { ...requestParams, id, timeoutMs: 900_000, durable: true };
      const scope = { ...sessionScope, assertCurrent() {} };
      try {
        expect((await f.call("question.request", params, f.runtime))[1]).toMatchObject({
          durable: true,
        });
        broadcast.mockClear();
        f.browser.socket.send.mockClear();
        const foreignPeer = createQuestionTestPeer(foreign, "foreign-durable");
        for (const client of [foreignPeer.client, f.browser.client]) {
          const original = client.authenticatedUserProfile;
          client.authenticatedUserProfile = foreignPeer.client.authenticatedUserProfile;
          try {
            expect(await f.call("question.resolve", { id, answers }, client)).toMatchObject([
              false,
              undefined,
              { details: { reason: "QUESTION_NOT_FOUND" } },
            ]);
            expect(
              await questionStorage.executeSessionQuestionOperation(scope, { kind: "get", id }),
            ).toMatchObject({
              record: { status: "pending" },
              continuation: { status: "pending" },
            });
            expect(broadcast).not.toHaveBeenCalled();
            expect(f.browser.socket.send).not.toHaveBeenCalled();
            expect(foreignPeer.socket.send).not.toHaveBeenCalled();
          } finally {
            client.authenticatedUserProfile = original;
          }
        }
        expect((await f.call("question.resolve", { id, answers }))[1]).toEqual({
          status: "answered",
          answers,
        });
        expect(
          await questionStorage.executeSessionQuestionOperation(scope, { kind: "get", id }),
        ).toMatchObject({
          record: { status: "answered", answers },
          continuation: { status: "owed" },
        });
      } finally {
        await f.close();
      }
    });
  });

  it.each([
    ["register", "transaction"],
    ["register", "commit"],
    ["settle", "transaction"],
    ["settle", "commit"],
  ] as const)(
    "refuses %s when authority is revoked at native %s admission",
    async (operation, stage) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const f = await createOwnRunFixture(true);
        const id = "revoked-native-admission";
        const params = { ...requestParams, id, timeoutMs: 900_000, durable: true };
        const scope = { ...sessionScope, assertCurrent() {} };
        let responderCurrent = true;
        let revoked = false;
        let active = false;
        const operate = questionStorage.executeSessionQuestionOperation;
        let restore = () => {};
        try {
          if (operation === "settle") {
            expect((await f.call("question.request", params, f.runtime))[1]).toMatchObject({
              durable: true,
            });
          }
          broadcast.mockClear();
          f.browser.socket.send.mockClear();
          const channel = vi.spyOn(questionChannel, "handleQuestionChannelRequested");
          const storageSpy = vi
            .spyOn(questionStorage, "executeSessionQuestionOperation")
            .mockImplementation(async (target, input) => {
              active = input.kind === operation;
              try {
                return await operate(target, input);
              } finally {
                active = false;
              }
            });
          const create = workerAdmission.createSqliteWorkerOperationAdmission;
          const admissionSpy = vi
            .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
            .mockImplementation((callback, attachment) =>
              create((request, grant) => {
                if (active && request.stage === stage && !revoked) {
                  revoked = true;
                  if (operation === "register") {
                    f.revokeSource();
                  } else {
                    responderCurrent = false;
                  }
                }
                callback(request, grant);
              }, attachment),
            );
          restore = () => {
            channel.mockRestore();
            storageSpy.mockRestore();
            admissionSpy.mockRestore();
          };
          const request =
            operation === "register"
              ? f.call("question.request", params, f.runtime)
              : callQuestionRpc(
                  "question.resolve",
                  { id, answers },
                  {
                    cfg: f.cfg,
                    client: f.browser.client,
                    registered: true,
                    hasCurrentClientAuthority: () => responderCurrent,
                  },
                );
          await expect(request).rejects.toThrow(
            operation === "register"
              ? "Original question source revoked"
              : "Gateway requester authority changed",
          );
          expect(revoked, "the request must reach the real worker admission edge").toBe(true);
          expect(
            await questionStorage.executeSessionQuestionOperation(scope, { kind: "get", id }),
          ).toEqual(
            operation === "register"
              ? undefined
              : expect.objectContaining({
                  record: expect.objectContaining({ status: "pending" }),
                  continuation: { status: "pending" },
                }),
          );
          expect(broadcast).not.toHaveBeenCalled();
          expect(channel).not.toHaveBeenCalled();
          expect(f.browser.socket.send).not.toHaveBeenCalled();
        } finally {
          restore();
          await f.close();
        }
      });
    },
  );
});
