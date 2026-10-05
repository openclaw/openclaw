import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { nativeWorkerLifecycleEntrypoint } from "./worker-native-lifecycle.runtime.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

type Ending = (typeof cases)[number]["ending"] | "resource-late-attachment";

async function runFixture(ending: Ending): Promise<unknown> {
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

const resourceCustody = {
  firstCloseRejected: true,
  sameOwnerRetried: true,
  childClosedBeforeStopped: true,
  sqliteReusable: true,
};
const supervisorLoss = {
  ...resourceCustody,
  rejectedWhileBlocked: true,
  retryRejectedWhileBlocked: true,
  brokerOwnerSurvived: true,
};
const callbackContext = ["message", "error", "exit"].map((event) => ({
  event,
  context: "constructor-A",
}));
const cases = [
  {
    ending: "resource-idle-broker",
    expected: {
      ...resourceCustody,
      independentCustodyPreserved: true,
      idleBrokerJoined: true,
      sourceReusable: true,
    },
  },
  {
    ending: "callback-context",
    expected: {
      directSeen: callbackContext,
      retainedSeen: callbackContext,
      diagnosticsPreserved: true,
      joined: true,
    },
  },
  {
    ending: "supervisor-loss",
    expected: {
      rejectedWhileBlocked: true,
      retryRejectedWhileBlocked: true,
      joinedOnlyAfterYield: true,
    },
  },
  {
    ending: "resource-cold-supervisor-loss",
    expected: {
      unavailableBeforeReady: true,
      sameSourceRetained: true,
      sameBrokerRetried: true,
      neverAdmittedResourceClosed: true,
      brokerClosed: true,
    },
  },
  {
    ending: "native-resource",
    expected: { ...resourceCustody, shutdownRefused: true, lateNativeJoin: true },
  },
  { ending: "resource-supervisor-loss", expected: supervisorLoss },
  ...(
    [
      "resource-auto-close-success",
      "resource-auto-close-failure",
      "resource-auto-close-refusal",
    ] as const
  ).map((ending) => ({
    ending,
    expected: {
      ...supervisorLoss,
      originalBrokerJoined: true,
      nativeBrokerCloses: 1,
      ...(ending === "resource-auto-close-success"
        ? { rotatedAfterBrokerClose: true }
        : { originalFailureOccurrences: 1 }),
    },
  })),
  {
    ending: "resource-close-supervisor-loss",
    expected: { ...supervisorLoss, originalCloseJoined: true },
  },
  {
    ending: "resource-owner-reply-loss",
    expected: {
      ...supervisorLoss,
      retainedReplyDelivered: true,
      ownerRepliesOrderedOnce: true,
      ownerReplyRejectionPreserved: true,
    },
  },
  {
    ending: "explicit-unbound",
    expected: {
      ambientReleased: true,
      value: 42,
      nativeJoined: true,
      idleReused: true,
      shutdownJoined: true,
    },
  },
  ...(["terminate", "natural-exit"] as const).map((ending) => ({
    ending,
    expected: {
      value: 42,
      nativeJoined: true,
      nestedSqliteReleased: true,
      promiseCallbackRanWhileBlocked: false,
    },
  })),
  {
    ending: "generation",
    expected: {
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
    },
  },
] as const;

describe("retained native worker lifecycle", () => {
  it.each(cases)(
    "preserves native custody during $ending",
    async ({ ending, expected }) => {
      expect(await runFixture(ending)).toEqual({ ending, ...expected });
    },
    20_000,
  );

  it("attaches a second resource to the same healthy broker after its cold startup deadline", async () => {
    expect(await runFixture("resource-late-attachment")).toEqual({
      ending: "resource-late-attachment",
      lateSameBrokerAttached: true,
      ...resourceCustody,
    });
  }, 50_000);
});
