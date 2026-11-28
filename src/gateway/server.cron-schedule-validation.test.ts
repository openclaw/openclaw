// Gateway WebSocket coverage for correcting an unreadable schedule before it is saved.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, test } from "vitest";
import {
  expectCronJobIdFromResponse,
  expectCronRows,
} from "./server.cron.assertions.test-support.js";
import { installGatewayTestHooks, rpcReq, startConnectedServerWithClient } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

test("explains how to correct an unreadable one-time schedule without changing saved jobs", async () => {
  const { ws, server, envSnapshot } = await startConnectedServerWithClient();
  const request = (method: string, params: Record<string, unknown>) => rpcReq(ws, method, params);
  try {
    const job = {
      name: "one-time schedule",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "systemEvent", text: "synthetic schedule fixture" },
    };
    const id = expectCronJobIdFromResponse(await request("cron.add", job));
    const original = await request("cron.get", { id });
    expect(original.ok).toBe(true);
    const schedule = { kind: "at", at: "synthetic-unreadable-time" };
    const add = await request("cron.add", { ...job, schedule });
    const update = await request("cron.update", { id, patch: { schedule } });

    expect(expectCronRows(await request("cron.list", {}), "jobs").map((row) => row.id)).toEqual([
      id,
    ]);
    expect((await request("cron.get", { id })).payload).toEqual(original.payload);

    const message =
      /^OpenClaw couldn’t read the scheduled time\. Enter a future date and time, such as (\S+)\.$/;
    for (const response of [add, update]) {
      expect(response).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: expect.stringMatching(message) },
      });
    }

    const at = expectDefined(add.error?.message?.match(message)?.[1], "future date example");
    const corrected = { kind: "at", at };
    const addedId = expectCronJobIdFromResponse(
      await request("cron.add", { ...job, schedule: corrected }),
    );
    expect(await request("cron.update", { id, patch: { schedule: corrected } })).toMatchObject({
      ok: true,
    });
    for (const jobId of [addedId, id]) {
      expect(await request("cron.get", { id: jobId })).toMatchObject({
        ok: true,
        payload: { schedule: corrected },
      });
    }
  } finally {
    ws.close();
    await server.close();
    envSnapshot.restore();
  }
});
