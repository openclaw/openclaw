import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { nativeWorkerLifecycleEntrypoint } from "./worker-native-lifecycle.runtime.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

async function runFixture(
  ending:
    | "terminate"
    | "natural-exit"
    | "generation"
    | "explicit-unbound"
    | "supervisor-loss"
    | "native-resource"
    | "resource-supervisor-loss"
    | "resource-close-supervisor-loss"
    | "resource-late-attachment"
    | "resource-owner-reply-loss"
    | "callback-context",
): Promise<unknown> {
  const home = directories.make("worker-native-lifecycle-");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(nativeWorkerLifecycleEntrypoint)),
      ending,
      home,
    ],
    {
      timeout: ending === "resource-late-attachment" ? 45_000 : 15_000,
      killSignal: "SIGKILL",
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, TSX_DISABLE_CACHE: "1" },
    },
  );
  return JSON.parse(stdout);
}

describe("retained native worker lifecycle", () => {
  it("preserves constructor ALS for callbacks serviced from another context", async () => {
    const expected = ["message", "error", "exit"].map((event) => ({
      event,
      context: "constructor-A",
    }));
    expect(await runFixture("callback-context")).toEqual({
      ending: "callback-context",
      directSeen: expected,
      retainedSeen: expected,
      diagnosticsPreserved: true,
      joined: true,
    });
  }, 20_000);

  it("rejects stop and retry after supervisor loss while blocked, then joins after native exit", async () => {
    expect(await runFixture("supervisor-loss")).toEqual({
      ending: "supervisor-loss",
      rejectedWhileBlocked: true,
      retryRejectedWhileBlocked: true,
      joinedOnlyAfterYield: true,
    });
  }, 20_000);

  it("retains a real SQLite child through failed resource close and same-owner retry", async () => {
    expect(await runFixture("native-resource")).toEqual({
      ending: "native-resource",
      firstCloseRejected: true,
      sameOwnerRetried: true,
      childClosedBeforeStopped: true,
      sqliteReusable: true,
    });
  }, 20_000);

  it("retains the broker's SQLite child after supervisor loss until the same owner closes it", async () => {
    expect(await runFixture("resource-supervisor-loss")).toEqual({
      ending: "resource-supervisor-loss",
      rejectedWhileBlocked: true,
      retryRejectedWhileBlocked: true,
      brokerOwnerSurvived: true,
      firstCloseRejected: true,
      sameOwnerRetried: true,
      childClosedBeforeStopped: true,
      sqliteReusable: true,
    });
  }, 20_000);

  it("joins an accepted resource close when its supervising Worker is lost mid-close", async () => {
    expect(await runFixture("resource-close-supervisor-loss")).toEqual({
      ending: "resource-close-supervisor-loss",
      originalCloseJoined: true,
      rejectedWhileBlocked: true,
      retryRejectedWhileBlocked: true,
      brokerOwnerSurvived: true,
      firstCloseRejected: true,
      sameOwnerRetried: true,
      childClosedBeforeStopped: true,
      sqliteReusable: true,
    });
  }, 20_000);

  it("attaches a second resource to the same healthy broker after its cold startup deadline", async () => {
    expect(await runFixture("resource-late-attachment")).toEqual({
      ending: "resource-late-attachment",
      lateSameBrokerAttached: true,
      firstCloseRejected: true,
      sameOwnerRetried: true,
      childClosedBeforeStopped: true,
      sqliteReusable: true,
    });
  }, 50_000);

  it("preserves ordered owner replies and their success or failure through supervisor loss", async () => {
    expect(await runFixture("resource-owner-reply-loss")).toEqual({
      ending: "resource-owner-reply-loss",
      retainedReplyDelivered: true,
      ownerRepliesOrderedOnce: true,
      ownerReplyRejectionPreserved: true,
      rejectedWhileBlocked: true,
      retryRejectedWhileBlocked: true,
      brokerOwnerSurvived: true,
      firstCloseRejected: true,
      sameOwnerRetried: true,
      childClosedBeforeStopped: true,
      sqliteReusable: true,
    });
  }, 20_000);

  it("keeps an explicitly unbound source usable after the ambient generation releases", async () => {
    expect(await runFixture("explicit-unbound")).toEqual({
      ending: "explicit-unbound",
      ambientReleased: true,
      value: 42,
      nativeJoined: true,
    });
  }, 20_000);

  it.each(["terminate", "natural-exit"] as const)(
    "services results and joins nested SQLite custody during %s while main is blocked",
    async (ending) => {
      expect(await runFixture(ending)).toEqual({
        ending,
        value: 42,
        nativeJoined: true,
        nestedSqliteReleased: true,
        promiseCallbackRanWhileBlocked: false,
      });
    },
    20_000,
  );

  it("joins all admitted owners before releasing their shared supervisor and generation", async () => {
    expect(await runFixture("generation")).toEqual({
      ending: "generation",
      order: [
        "operation",
        "owner-close-start",
        "queued-worker-started",
        "worker-usable-during-close",
        "native-joined",
        "sibling-owner-close",
        "sibling-native-joined",
        "release",
      ],
      nativeJoined: true,
      siblingJoined: true,
      supervisorJoined: true,
      directoryReleased: true,
      terminalSamplesRejected: true,
    });
  }, 20_000);
});
