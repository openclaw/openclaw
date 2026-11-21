import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";

export function useExecutorFixture(
  prefix: string,
  options: {
    splitRoots?: boolean;
    controlMode?: number;
    beforeCleanup?: () => Promise<void>;
    restoreEnv?: boolean;
  } = {},
) {
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await options.beforeCleanup?.();
      cleanup();
    }),
  );
  afterEach(() => {
    vi.restoreAllMocks();
    if (options.restoreEnv) {
      vi.unstubAllEnvs();
    }
  });
  return () => {
    const base = fs.realpathSync(dirs.make(prefix));
    const root = options.splitRoots ? path.join(base, "package-B") : base;
    const serviceRoot = options.splitRoots ? path.join(base, "service-A") : root;
    const control = path.join(base, "control");
    for (const directory of options.splitRoots ? [root, serviceRoot, control] : [control]) {
      fs.mkdirSync(directory, {
        mode: directory === control ? (options.controlMode ?? 0o700) : 0o700,
      });
    }
    // Only the database location is mocked; lease custody remains production-owned.
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    return { root, serviceRoot, control };
  };
}

export function useExecutorReceipts() {
  let channel: FixtureReceiptChannel;
  beforeAll(async () => {
    channel = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await channel?.close();
  });
  return {
    get channel() {
      return channel;
    },
    ready(marker: string, operation: PromiseLike<unknown>) {
      // The marker precedes the receipt; command settlement can beat socket delivery.
      const settled = Promise.resolve(operation).then(
        () => {
          expect(fs.existsSync(marker)).toBe(true);
        },
        (error: unknown) => {
          if (!fs.existsSync(marker)) {
            throw error;
          }
        },
      );
      return Promise.race([channel.waitFor(marker, "ready"), settled]);
    },
  };
}
