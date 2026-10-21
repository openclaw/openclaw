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

const trueFields = (keys: string) => Object.fromEntries(keys.split(" ").map((key) => [key, true]));
const resourceCustody = trueFields(
  "firstCloseRejected sameOwnerRetried childClosedBeforeStopped sqliteReusable",
);
const callbackContext = ["message", "error", "exit"].map((event) => ({
  event,
  context: "constructor-A",
}));
const nativeExit = {
  value: 42,
  ...trueFields("nativeJoined nestedSqliteReleased"),
  promiseCallbackRanWhileBlocked: false,
};
const cases = [
  {
    ending: "resource-idle-broker",
    ...resourceCustody,
    ...trueFields("independentCustodyPreserved idleBrokerJoined sourceReusable"),
  },
  {
    ending: "callback-context",
    directSeen: callbackContext,
    retainedSeen: callbackContext,
    ...trueFields("diagnosticsPreserved joined"),
  },
  { ending: "native-resource", ...resourceCustody },
  {
    ending: "explicit-unbound",
    value: 42,
    ...trueFields("ambientReleased nativeJoined idleReused shutdownJoined"),
  },
  { ending: "terminate", ...nativeExit },
  { ending: "natural-exit", ...nativeExit },
  {
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
    ...trueFields(
      "nativeJoined siblingJoined supervisorJoined directoryReleased terminalSamplesRejected",
    ),
  },
] as const;

describe("retained native worker lifecycle", () => {
  it.each(cases)(
    "preserves native custody during $ending",
    async ({ ending, ...expected }) => {
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
