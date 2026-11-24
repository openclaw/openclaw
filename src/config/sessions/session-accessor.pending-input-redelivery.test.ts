// A channel source turn whose first transcript append failed, redelivered with fresh downloads.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import { stagedInputDirectory, stagedInputFileName } from "../../media/staged-inputs.js";
import { getMediaDir } from "../../media/store-path.js";
import { saveMediaBuffer } from "../../media/store.js";
import { settleUserTurnPendingInput } from "../../sessions/user-turn-transcript-processing.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  listSessionPendingInputs,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

const transcriptFault = useSqliteWorkerFault([
  {
    name: "reject_transcript_append",
    match: /^insert into transcript_events\b/u,
    sql: `CREATE TEMP TRIGGER reject_transcript_append BEFORE INSERT ON main.transcript_events
      BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: transcript_events.seq'); END`,
  },
]);
const fixture = useTempSessionsFixture("pending-input-redelivery-");
const sessionId = "redelivery-session";
const scope = () => ({
  agentId: "main",
  sessionKey: "agent:main:telegram:direct:111",
  sessionId,
  storePath: fixture.storePath(),
});
const storedRow = () =>
  openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())))
    .db.prepare("SELECT run_id, state, request_hash FROM session_pending_inputs")
    .get();
// Telegram saves photos by store ID and named files as "<name>---<store ID>".
const download = async (name?: string) =>
  (await saveMediaBuffer(Buffer.from("jpeg"), "image/jpeg", "inbound", undefined, name)).path;
type Media = { path: string; url?: string; contentType: string; workspaceDir?: string };
const photo = (location: string): Media => ({
  path: location,
  url: location,
  contentType: "image/jpeg",
});
// Each turn stages its downloads into the agent workspace, as stage-sandbox-media does.
const staged = (id: string, directory = stagedInputDirectory(randomUUID())): Media => {
  const workspaceDir = path.resolve(fixture.sessionsDir(), "../../../workspace");
  return {
    path: path.join(workspaceDir, directory, stagedInputFileName(id)),
    url: `media://inbound/${id}`,
    contentType: "image/jpeg",
    workspaceDir,
  };
};
const saved = async (name?: string) => staged(path.basename(await download(name)));

beforeEach(async () => {
  const stateDir = path.resolve(fixture.sessionsDir(), "../../..");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  expect(getMediaDir()).toBe(path.join(stateDir, "media"));
  setRuntimeConfigSnapshot({ session: { store: fixture.storePath() } });
  await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
});
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

// Mirrors get-reply-run-execute for a durable channel turn; each delivery mints a run.
const attempt = (runId: string, media?: Media[], text = "what is in this photo?") => {
  const recorder = createUserTurnTranscriptRecorder({
    reclaimCancelledSourceTurn: true,
    target: () => ({ ...scope(), sessionEntry: { sessionId, updatedAt: 1 } }),
    input: { text, idempotencyKey: "channel-user:v1:redelivered-turn", media },
  });
  return { recorder, stage: () => recorder.stageApproved!({ runId, assertCurrent: () => {} }) };
};
const failFirstAppend = async (media?: Media[], endCause?: "user-stop") => {
  const original = attempt("ingress-attempt-1", media);
  expect(await original.stage()).toBe(true);
  transcriptFault.enable();
  const failure = await original.recorder.persistApproved().catch((error: unknown) => error);
  transcriptFault.disable();
  expect(String(failure)).toContain("UNIQUE constraint failed");
  if (endCause) {
    original.recorder.finishPendingInput!("cancelled", endCause);
    await original.recorder.waitForPendingInputSettlement?.();
  } else {
    await settleUserTurnPendingInput(original.recorder, undefined, failure);
  }
  return storedRow() as { request_hash: string; state: string };
};
const answer = async (media?: Media[]) => {
  const redelivery = attempt("ingress-attempt-2", media);
  expect(await redelivery.stage()).toBe(true);
  return redelivery;
};

it.each([
  ["text", undefined],
  ["photo", [undefined]],
  ["album", [undefined, "holiday.jpg"]],
  // Only the trailing store UUID varies; one inside the original filename is source content.
  ["UUID-named file", ["report-0d5e7a4c-1b2f-4c3d-8e9f-a0b1c2d3e4f5.jpg"]],
  ["unstaged photo", [undefined], async () => photo(await download())],
])(
  "answers a %s redelivery once under its accepted hash and bytes",
  async (_, names, save = saved) => {
    const accepted = names && (await Promise.all(names.map(save)));
    const receipt = await failFirstAppend(accepted);
    expect(receipt).toMatchObject({
      state: "cancelled",
      request_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    const redelivery = await answer(names && (await Promise.all(names.map(save))));
    expect(storedRow()).toEqual({ ...receipt, run_id: "ingress-attempt-2", state: "queued" });
    await redelivery.recorder.persistApproved();
    await settleUserTurnPendingInput(redelivery.recorder);

    expect((await listSessionPendingInputs(scope())).items).toEqual([]);
    const media = accepted?.map((fact) => ({ path: fact.path }));
    expect(
      (await loadTranscriptEvents(scope())).filter((event) => event.type === "message"),
    ).toMatchObject([
      { message: { content: "what is in this photo?", ...(media && { __openclaw: { media } }) } },
    ]);
  },
);

it("refuses a redelivery whose source input differs from the accepted attempt", async () => {
  const receipt = await failFirstAppend([await saved("holiday.jpg")]);
  const retry = await saved("holiday.jpg");
  const id = retry.url!.slice("media://inbound/".length);
  for (const [media, text] of [
    [[await saved("holiday.jpg")], "a different caption"],
    [[await saved("scan.jpg")]],
    [[await saved("holiday.jpg"), await saved("holiday.jpg")]],
    [[{ ...(await saved("holiday.jpg")), url: "https://cdn.example.test/holiday.jpg" }]],
    [[photo(path.join(fixture.sessionsDir(), `holiday---${randomUUID()}.jpg`))]],
    [[staged(id, "media/inbound/elsewhere")]],
    [[{ ...retry, url: (await saved("holiday.jpg")).url }]],
  ] as const) {
    await expect(attempt("ingress-attempt-2", [...media], text).stage()).rejects.toThrow(
      "idempotency key conflicts",
    );
  }
  expect(storedRow()).toEqual({ ...receipt, run_id: "ingress-attempt-1" });
});

it("refuses a file whose own name carries a different UUID", async () => {
  const receipt = await failFirstAppend([await saved(`report-${randomUUID()}.jpg`)]);
  await expect(
    attempt("ingress-attempt-2", [await saved(`report-${randomUUID()}.jpg`)]).stage(),
  ).rejects.toThrow("idempotency key conflicts");
  expect(storedRow()).toEqual({ ...receipt, run_id: "ingress-attempt-1" });
});

it("never reopens a stopped media source turn", async () => {
  const receipt = await failFirstAppend([await saved()], "user-stop");
  await expect(attempt("ingress-attempt-2", [await saved()]).stage()).rejects.toThrow(
    "idempotency key conflicts",
  );
  expect(storedRow()).toEqual({ ...receipt, run_id: "ingress-attempt-1" });
});
