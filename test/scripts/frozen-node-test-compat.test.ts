import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const candidateSha = "f773aa06a1a93b36b050f1a3f4b57d3d91311541";
const action = join(process.cwd(), ".github/actions/frozen-node-test-compat/apply.mjs");
const staleDrain = "    await vi.advanceTimersByTimeAsync(21_000);";
const staleRoutingTest = `  it("wakes main watchers but only queues notices for nested watchers", async () => {
    vi.useFakeTimers();
    const wakes = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(wakes);
    // Drain notices queued by earlier tests before checking this watcher's routing.
    await vi.advanceTimersByTimeAsync(21_000);
    wakes.mockClear();
    const database = createDatabaseOptions();
    seedChild(database, nestedWatcher);

    recordSessionStateEvent(eventInput({ watcherSessionKeys: [nestedWatcher] }), database);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(peekSystemEventEntries(nestedWatcher)).toHaveLength(1);
    expect(wakes).not.toHaveBeenCalled();

    seedChild(database, watcher);
    recordSessionStateEvent(eventInput(), database);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(wakes).toHaveBeenCalledWith(
      // intent "immediate" is load-bearing: event-intent wakes defer on heartbeat
      // dueness and would sit on the notice until the next scheduled tick. The
      // wake itself coalesces for SESSION_STATE_WAKE_COALESCE_MS (20s), hence
      // the 21s timer advances in these tests.
      expect.objectContaining({
        source: "session-state",
        sessionKey: watcher,
        intent: "immediate",
      }),
    );
  });`;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createFixture({ repeatedDrains = 3 }: { repeatedDrains?: number } = {}) {
  const root = tempDirs.make("openclaw-frozen-node-test-compat-");
  const testFile = join(root, "src/sessions/session-state-events.test.ts");
  mkdirSync(join(root, "src/sessions"), { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".git/HEAD"), `${candidateSha}\n`);
  writeFileSync(
    testFile,
    [
      'import { setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";',
      staleRoutingTest,
      ...Array.from({ length: repeatedDrains }, () =>
        ["    disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(wakes);", staleDrain].join(
          "\n",
        ),
      ),
      "",
    ].join("\n"),
  );
  return { root, testFile };
}

describe("frozen Node test compatibility", () => {
  it("repairs only the four attested stale timer drains", () => {
    const fixture = createFixture();

    execFileSync(process.execPath, [action, "--root", fixture.root, "--target-sha", candidateSha]);

    const repaired = readFileSync(fixture.testFile, "utf8");
    expect(repaired.match(/await vi\.runAllTimersAsync\(\);/gu)).toHaveLength(4);
    expect(repaired).not.toContain(
      `disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(wakes);\n${staleDrain}`,
    );
    expect(repaired).toContain("Pending deadlines may belong to a previous fake-clock origin.");
    expect(repaired).toContain("it.each([false, true])");
    expect(repaired).toContain("requestHeartbeat, setHeartbeatWakeHandler");
  });

  it("fails closed when the attested test shape drifts", () => {
    const fixture = createFixture({ repeatedDrains: 2 });

    const result = spawnSync(
      process.execPath,
      [action, "--root", fixture.root, "--target-sha", candidateSha],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "expected one import, one routing test, and three repeated stale drains",
    );
    expect(readFileSync(fixture.testFile, "utf8")).toContain(staleDrain);
  });
});
