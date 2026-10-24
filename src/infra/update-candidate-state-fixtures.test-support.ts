import { afterAll, beforeAll, vi } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { prepareUpdateCandidateStateSnapshot } from "./update-candidate-snapshot.js";
import { captureUpdateCandidateDeadline } from "./update-candidate-state.test-support.js";

export function useStateReceipts() {
  let channel: FixtureReceiptChannel;
  beforeAll(async () => {
    channel = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await channel?.close();
  });
  return {
    get endpoint() {
      return channel.endpoint;
    },
    waitFor: (...args: Parameters<FixtureReceiptChannel["waitFor"]>) => channel.waitFor(...args),
  };
}

export function captureStateOperation<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

export function stateClock() {
  const now = Date.now.bind(Date);
  let elapsed = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
  const expire = captureUpdateCandidateDeadline();
  return (milliseconds: number, expires = false) => {
    elapsed = milliseconds;
    if (expires) {
      expire();
    }
  };
}

export function snapshotFixture(
  root: string,
  stateDir: string,
  signal: AbortSignal,
  workerEnv: () => NodeJS.ProcessEnv = () => ({
    ...process.env,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  }),
) {
  return prepareUpdateCandidateStateSnapshot({
    config: {},
    stateDir,
    candidateRoot: root,
    env: { TMPDIR: root },
    workerEnv,
    signal,
  });
}
