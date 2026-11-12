import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { listSecretStoreEntries } from "../../secrets/store/secret-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  adminRequestClient,
  broadcast,
  callQuestionRpc as call,
  installQuestionTestHooks,
  manager,
  requestParams,
  requestSecretQuestion,
  secretRequestParams,
  storeWriteService,
} from "./question.test-support.js";

installQuestionTestHooks();

it("opts into incarnation at the RPC boundary without changing legacy records, replies or events", async () => {
  const [ok, created] = await call("question.request", {
    ...requestParams,
    includeIncarnation: true,
  });
  expect(ok).toBe(true);
  const { id, incarnation } = created as { id: string; incarnation: string };
  expect(incarnation).toEqual(expect.any(String));
  expect((await call("question.get", { id }))[1]).toMatchObject({ question: { id } });
  expect((await call("question.get", { id }))[1]).not.toHaveProperty("question.incarnation");
  expect((await call("question.get", { id, includeIncarnation: true }))[1]).toMatchObject({
    question: { id, incarnation },
  });
  expect((await call("question.list", { includeIncarnation: true }))[1]).toMatchObject({
    questions: [{ id, incarnation }],
  });
  expect((await call("question.list", {}))[1]).not.toHaveProperty("questions.0.incarnation");
  expect(
    broadcast.mock.calls.find(([event]) => event === "question.requested")?.[1],
  ).not.toHaveProperty("incarnation");
  const answers = { answers: { destination: ["Home"] } },
    resolutionId = "original-resolution";
  expect(
    await call("question.resolve", { id, expectedIncarnation: incarnation, answers, resolutionId }),
  ).toEqual([true, { status: "answered", answers, incarnation, resolutionId }, undefined]);
  expect(
    await call("question.waitAnswer", {
      id,
      expectedIncarnation: incarnation,
      includeResolutionId: true,
    }),
  ).toEqual([true, { status: "answered", answers, incarnation, resolutionId }, undefined]);
  expect(await call("question.waitAnswer", { id })).toEqual([
    true,
    { status: "answered", answers },
    undefined,
  ]);
  await manager.drain();
  expect(
    broadcast.mock.calls.find(([event]) => event === "question.resolved")?.[1],
  ).not.toHaveProperty("incarnation");
});

it.each(["answer", "cancel", "lookup"] as const)(
  "rejects stale %s against a recreated identical question",
  async (action) => {
    const [, created] = await call("question.request", {
      ...requestParams,
      id: "same-question",
      includeIncarnation: true,
    });
    const { id, incarnation } = created as { id: string; incarnation: string };
    manager.reset();
    const [, successor] = await call("question.request", {
      ...requestParams,
      id,
      includeIncarnation: true,
    });
    expect(successor).not.toMatchObject({ incarnation });
    const result =
      action === "lookup"
        ? await call("question.waitAnswer", {
            id,
            expectedIncarnation: incarnation,
            includeResolutionId: true,
          })
        : await call("question.resolve", {
            id,
            expectedIncarnation: incarnation,
            ...(action === "cancel"
              ? { cancel: true }
              : { answers: { answers: { destination: ["Home"] } } }),
          });
    expect(result).toMatchObject([
      false,
      undefined,
      { code: "INVALID_REQUEST", details: { reason: "QUESTION_INCARNATION_MISMATCH" } },
    ]);
    expect(manager.get(id)?.status).toBe("pending");
  },
);

it("keeps the native secret writer fenced when an awaited write loses its original entry", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const id = await requestSecretQuestion();
    const incarnation = manager.observe(id)!.incarnation;
    const entered = createDeferred(),
      release = createDeferred();
    const write = storeWriteService.write.bind(storeWriteService);
    vi.spyOn(storeWriteService, "write").mockImplementationOnce(async (params) => {
      entered.resolve();
      await release.promise;
      return write(params);
    });
    const pending = call("question.resolve", {
      id,
      expectedIncarnation: incarnation,
      answers: { answers: { secret_value: ["synthetic-secret-must-not-be-written"] } },
      resolutionId: "old-secret-resolution",
    });
    await entered.promise;
    manager.reset();
    try {
      const replacement = await call(
        "question.request",
        { ...secretRequestParams, id, includeIncarnation: true },
        { client: adminRequestClient },
      );
      expect(replacement[0]).toBe(true);
      expect(replacement[1]).not.toMatchObject({ incarnation });
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
    expect(manager.get(id)?.status).toBe("pending");
    expect(await listSecretStoreEntries({ scope: { kind: "team" } })).toEqual([]);
  });
});
