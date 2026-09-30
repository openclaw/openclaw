// Register shared pool mocks before modules that consume them.
// oxfmt-ignore
import { emptyReply, queueTask, source } from "./openclaw-state-read-worker.test-harness.js";
import { expect, it } from "vitest";
import type { AcpSessionReadInput } from "../acp/runtime/session-meta-keys.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureOpenClawStateReadSource } from "./openclaw-state-read-worker.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

it.each(["mcpOAuth.statuses", "userPreferences.values", "acpSessions.metadata"] as const)(
  "captures and charges the full %s batch before queued dispatch",
  async (type) => {
    const { options } = source();
    const context = captureOpenClawStateWorkerContext(options);
    const keys = ["principal-根🦞", "second-principal"];
    const expected = [...keys];
    const entry = {
      lifecycleRevision: "revision-根🦞",
      sessionId: "session-根🦞",
      sessionStartedAt: 0,
    };
    const metadata = { keys, legacyKey: "legacy-根🦞", entry };
    const entries: AcpSessionReadInput[] = [metadata, { keys: ["entry-without-optionals"] }];
    const expectedEntries: AcpSessionReadInput[] = [
      { ...metadata, keys: [...keys], entry: { ...entry } },
      { keys: ["entry-without-optionals"] },
    ];
    const dispatch = createDeferredCore();
    const baselineTask = queueTask(dispatch.promise);
    const task = queueTask(dispatch.promise);
    const baseline = captureOpenClawStateReadSource().createTransport({ type: "fleet.list" });
    const key = "notification-根🦞";
    const transport = captureOpenClawStateReadSource().createTransport(
      type === "mcpOAuth.statuses"
        ? { type, input: keys }
        : type === "userPreferences.values"
          ? { type, profileIds: keys, key }
          : { type, entries },
    );
    const controller = new AbortController();
    const authority = {
      signal: controller.signal,
      assertCurrent: context.admission.assertCurrent,
    };
    const location = { context, location: options.path, checkFreshAdmission: true };
    const baselineRead = baseline.startRead(location, authority).result;
    const read = transport.startRead(location, authority).result;
    try {
      const [baselineOptions, batchOptions] = await Promise.all([
        baselineTask.submitted,
        task.submitted,
      ]);
      const additionalBytes =
        Buffer.byteLength(type) -
        Buffer.byteLength("fleet.list") +
        (type === "acpSessions.metadata"
          ? expectedEntries.reduce(
              (bytes, input) =>
                bytes +
                input.keys.reduce((total, sessionKey) => total + Buffer.byteLength(sessionKey), 0) +
                Buffer.byteLength(input.legacyKey ?? "") +
                Buffer.byteLength(input.entry?.lifecycleRevision ?? "") +
                Buffer.byteLength(input.entry?.sessionId ?? "") +
                (input.entry?.sessionStartedAt === undefined ? 0 : 8),
              0,
            )
          : expected.reduce((bytes, profileId) => bytes + Buffer.byteLength(profileId), 0)) +
        (type === "userPreferences.values" ? Buffer.byteLength(key) : 0);
      expect(batchOptions.inputBytes).toBe(Number(baselineOptions.inputBytes) + additionalBytes);
      keys[0] = "changed-principal";
      keys.push("added-after-admission");
      metadata.legacyKey = "changed-legacy";
      entry.lifecycleRevision = "changed-revision";
      entry.sessionId = "changed-session";
      entry.sessionStartedAt = 99;
      entries.push({ keys: ["added-entry-after-admission"] });
      dispatch.resolve();
      expect((await task.captured).command).toEqual(
        type === "mcpOAuth.statuses"
          ? { type, input: expected }
          : type === "userPreferences.values"
            ? { type, profileIds: expected, key }
            : { type, entries: expectedEntries },
      );
      baselineTask.result.resolve(emptyReply);
      task.result.resolve(
        type === "mcpOAuth.statuses"
          ? {
              ok: true,
              type,
              sourceAdmitted: true,
              value: expected.map(() => ({ state: "unauthenticated" })),
            }
          : type === "userPreferences.values"
            ? { ok: true, type, sourceAdmitted: true, values: new Map() }
            : { ok: true, type, sourceAdmitted: true, rows: expectedEntries.map(() => null) },
      );
      await Promise.all([baselineRead, read]);
    } finally {
      dispatch.resolve();
      baselineTask.result.resolve(emptyReply);
      task.result.resolve(emptyReply);
      await Promise.allSettled([baselineRead, read]);
      await Promise.all([baseline.startClose().result, transport.startClose().result]);
    }
  },
);
