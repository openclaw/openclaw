import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as locks from "../../infra/json-files.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { skillsUploadHandlers } from "./skills-upload.js";

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
async function call(stage: string, params: Record<string, unknown>) {
  const method = "skills.upload." + stage;
  const respond = vi.fn();
  await expectDefined(
    skillsUploadHandlers[method],
    method,
  )({
    req: { type: "req", id: String(++serial), method, params },
    params,
    context,
    respond,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
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
  expect(begun).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ uploadId: expect.any(String) }),
    undefined,
  );
  const payload: unknown = expectDefined(begun.mock.calls[0], "begin response")[1];
  if (
    !payload ||
    typeof payload !== "object" ||
    !("uploadId" in payload) ||
    typeof payload.uploadId !== "string"
  ) {
    throw new Error("missing upload ID");
  }
  const uploadId = payload.uploadId;
  if (stage === "chunk") {
    return { uploadId, offset: 0, dataBase64: "AQID" };
  }
  expect(await call("chunk", { uploadId, offset: 0, dataBase64: "AQID" })).toHaveBeenCalledWith(
    true,
    expect.anything(),
    undefined,
  );
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
    const createLock = locks.createAsyncLock;
    using lock = vi.spyOn(locks, "createAsyncLock").mockImplementation(() => {
      const run = createLock();
      return (fn) =>
        run(async () => {
          entered.resolve();
          await release.promise;
          return fn();
        });
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
      expect
        .soft(await pending)
        .toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN", details: { code: "UPLOADS_DISABLED" } }),
        );
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
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    using fence = vi
      .spyOn(admission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === boundary) {
            reached = true;
            setEnabled(false);
          }
          admit(request, grant);
        }, attachment),
      );
    expect
      .soft(await call(stage, params))
      .toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN", details: { code: "UPLOADS_DISABLED" } }),
      );
    expect(fence).toHaveBeenCalled();
    expect(reached).toBe(true);
    expect(snapshot()).toEqual(before);
  },
);
