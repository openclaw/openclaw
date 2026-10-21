import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { KeyedAsyncQueue, type KeyedAsyncQueueHooks } from "../../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { skillsUploadHandlers } from "./skills-upload.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

let state: OpenClawTestState;
let config: OpenClawConfig;
let serial = 0;
const context = createDirectChatContext({
  getRuntimeConfig: () => config,
  getCommittedRuntimeConfig: () => config,
});
function setEnabled(enabled: boolean) {
  config = {
    gateway: { uploads: { enabled } },
    skills: { install: { allowUploadedArchives: true } },
  };
}
function call(stage: string, params: Record<string, unknown>) {
  return callGatewayHandler(skillsUploadHandlers, `skills.upload.${stage}`, params, { context });
}
function expectDisabled(result: Awaited<ReturnType<typeof call>>) {
  expect.soft(result).toMatchObject({
    ok: false,
    response: undefined,
    error: expect.objectContaining({ code: "FORBIDDEN", details: { code: "UPLOADS_DISABLED" } }),
  });
}
function snapshot() {
  const { db } = openOpenClawStateDatabase();
  return {
    uploads: db.prepare("SELECT * FROM skill_uploads ORDER BY upload_id").all(),
    chunks: db.prepare("SELECT * FROM skill_upload_chunks ORDER BY upload_id, byte_offset").all(),
  };
}
async function prepare(stage: string) {
  const params = { kind: "skill-archive", slug: "policy-" + ++serial, sizeBytes: 3 };
  if (stage === "begin") {
    return params;
  }
  const begun = await call("begin", params);
  expect(begun).toMatchObject({
    ok: true,
    response: { uploadId: expect.any(String) },
    error: undefined,
  });
  const payload = begun.response;
  if (!isRecord(payload) || typeof payload.uploadId !== "string") {
    throw new Error("missing upload ID");
  }
  const uploadId = payload.uploadId;
  if (stage === "chunk") {
    return { uploadId, offset: 0, dataBase64: "AQID" };
  }
  expect(await call("chunk", { uploadId, offset: 0, dataBase64: "AQID" })).toMatchObject({
    ok: true,
    response: expect.anything(),
    error: undefined,
  });
  return { uploadId };
}
beforeAll(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-upload-policy-",
  });
});
afterAll(async () => {
  await state.cleanup();
});
beforeEach(() => {
  setEnabled(true);
});

it.each(["begin", "chunk", "commit"])(
  "rejects queued skill %s after hot disable before any persisted effect",
  async (stage) => {
    const params = await prepare(stage);
    const before = snapshot();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    // oxlint-disable-next-line typescript/unbound-method -- The observer calls the original with its queue receiver.
    const enqueue = KeyedAsyncQueue.prototype.enqueue;
    using lock = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue").mockImplementation(function <T>(
      this: KeyedAsyncQueue,
      key: string,
      task: () => Promise<T>,
      hooks?: KeyedAsyncQueueHooks,
    ) {
      return (enqueue<T>).call(
        this,
        key,
        async () => {
          entered.resolve();
          await release.promise;
          return task();
        },
        hooks,
      );
    });
    const pending = call(stage, params);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("request did not acquire upload lock");
        }),
      ]);
      setEnabled(false);
      release.resolve();
      expectDisabled(await pending);
      expect(snapshot()).toEqual(before);
      expect(lock).toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending;
    }
  },
);

it.each(
  ["begin", "chunk", "commit"].flatMap((stage) =>
    ["transaction", "commit"].map((boundary) => ({ stage, boundary })),
  ),
)(
  "rejects skill $stage at native $boundary admission without persisting bytes or metadata",
  async ({ stage, boundary }) => {
    const params = await prepare(stage);
    const before = snapshot();
    let reached = false;
    using fence = probe.admission(admission, (request, grant, admit) => {
      if (request.stage === boundary) {
        reached = true;
        setEnabled(false);
      }
      admit(request, grant);
    });
    expectDisabled(await call(stage, params));
    expect(fence).toHaveBeenCalled();
    expect(reached).toBe(true);
    expect(snapshot()).toEqual(before);
  },
);
