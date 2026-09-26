import assert from "node:assert/strict";
import { it } from "vitest";
import { createSessionHistoryWorkerReaders } from "./session-transcript-worker-readers.js";
import type { SessionHistoryWorkerRequestRunner } from "./session-transcript-worker-readers.js";

it("spreads env before submitting exact-entries reads so Windows env proxies stay cloneable", async () => {
  const submitted: unknown[] = [];
  const runRequest: SessionHistoryWorkerRequestRunner = (prepare, _inputBytes, receive) => {
    submitted.push(prepare());
    return Promise.resolve(
      receive({
        kind: "session-exact-entries",
        entries: [],
        lifecycleTimestamps: {},
      }),
    );
  };
  const readers = createSessionHistoryWorkerReaders(runRequest);
  // cloneEnvWithPlatformSemantics returns a proxy on Windows to keep case-insensitive
  // process.env semantics; a proxy cannot cross the worker structured-clone boundary.
  const proxiedEnv = new Proxy({ OPENCLAW_STATE_DIR: "C:\\openclaw" }, {});

  await readers.readExactEntries({
    env: proxiedEnv,
    sessionKeys: ["agent:main:main"],
    projection: "full",
  });

  assert.equal(submitted.length, 1);
  const input = submitted[0] as { env: NodeJS.ProcessEnv };
  assert.equal(input.env.OPENCLAW_STATE_DIR, "C:\\openclaw");
  // The regression: worker pool submission structured-clones the prepared input.
  assert.doesNotThrow(() => structuredClone(submitted[0]));
});
