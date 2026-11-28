import { afterEach, beforeEach, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { runSessionTurnPostimageTests } from "./session-turn-commit.test-support.js";
import { useTempSessionsFixture } from "./test-helpers.js";

const fixture = useTempSessionsFixture("openclaw-turn-postimages-");
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

runSessionTurnPostimageTests({
  engine: "sqlite",
  storePath: fixture.storePath,
  run: (run) => run(),
});
