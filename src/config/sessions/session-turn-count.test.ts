import { afterEach, beforeEach, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { runSessionTurnCountTests } from "./session-turn-commit.test-support.js";
import { useTempSessionsFixture } from "./test-helpers.js";

const fixture = useTempSessionsFixture("openclaw-turn-count-");
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

runSessionTurnCountTests({ engine: "sqlite", storePath: fixture.storePath, run: (run) => run() });
