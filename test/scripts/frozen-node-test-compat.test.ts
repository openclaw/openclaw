import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyFrozenNodeTestCompatibility } from "../../.github/actions/frozen-node-test-compat/apply.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const candidateSha = "f773aa06a1a93b36b050f1a3f4b57d3d91311541";
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
const tempDirs: string[] = [];

afterEach(() => cleanupTempDirs(tempDirs));

function createFixture({ repeatedDrains = 3 }: { repeatedDrains?: number } = {}) {
  const root = makeTempDir(tempDirs, "openclaw-frozen-node-test-compat-");
  const testFile = join(root, "src/sessions/session-state-events.test.ts");
  mkdirSync(join(root, "src/sessions"), { recursive: true });
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

    expect(applyFrozenNodeTestCompatibility({ root: fixture.root, targetSha: candidateSha })).toBe(
      true,
    );

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

    expect(() =>
      applyFrozenNodeTestCompatibility({ root: fixture.root, targetSha: candidateSha }),
    ).toThrow("expected one import, one routing test, and three repeated stale drains");
    expect(readFileSync(fixture.testFile, "utf8")).toContain(staleDrain);
  });
});
