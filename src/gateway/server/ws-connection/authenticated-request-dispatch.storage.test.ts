import { expect, it } from "vitest";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import {
  appendWorkerRow,
  useSqliteWorkerStoreFixture,
} from "../../../infra/sqlite-worker-fixture.test-support.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

const { databasePath, open } = useSqliteWorkerStoreFixture("gateway-disk-full-");
const diskFullMessage =
  "OpenClaw couldn't save your conversation because the disk is full. Free up space on the computer running OpenClaw before continuing.";

it.each([
  { index: 0, retryable: false },
  { index: 1, retryable: true },
])(
  "reports disk-full guidance for write RPC $index (retryable: $retryable)",
  async ({ index, retryable }) => {
    const store = await open(databasePath(), { type: "disk-full" });
    let failure: unknown;
    const fixture = createDispatchTestHarness({
      extraHandlers: {
        "sessions.create": async () => {
          const outcomes = await Promise.allSettled([
            appendWorkerRow(store, "full"),
            appendWorkerRow(store, "queued"),
          ]);
          const outcome = outcomes[index];
          expect(outcome?.status).toBe("rejected");
          if (outcome?.status === "rejected") {
            failure = outcome.reason;
            throw failure;
          }
        },
      },
    });
    await fixture.dispatcher.dispatch(
      { type: "req", id: "disk-full", method: "sessions.create", params: {} },
      createOperatorWsClient(),
    );
    expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(!retryable);
    expect(await fixture.awaitResponseFrame("disk-full")).toMatchObject({
      ok: false,
      error: {
        code: ErrorCodes.UNAVAILABLE,
        message: diskFullMessage,
        retryable,
        details: { code: "SQLITE_FULL" },
      },
    });
    expect(fixture.logGateway.error).toHaveBeenCalledWith(expect.stringContaining("disk is full"));
  },
);
