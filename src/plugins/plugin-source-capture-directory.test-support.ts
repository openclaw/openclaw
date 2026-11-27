import { vi } from "vitest";
import * as command from "../process/exec-runner.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { retainPluginSourceCaptureInstance } from "./plugin-source-capture-directory.js";

export async function sweepPluginSourceCapturesForTest(stateDir: string): Promise<void> {
  const scheduler = createTestGatewayScheduler();
  const instance = retainPluginSourceCaptureInstance(stateDir);
  try {
    await instance.startMaintenance(scheduler);
  } finally {
    try {
      await scheduler.stop();
    } finally {
      await instance.releaseAsync();
    }
  }
}

/** Inject a physical failure into the real standalone reclaim process. */
export function interceptPluginCaptureReclamation(preload: string, onReply?: () => void) {
  const original = command.runCommandBuffersWithTimeout;
  return vi.spyOn(command, "runCommandBuffersWithTimeout").mockImplementation((argv, options) => {
    if (
      typeof options === "number" ||
      typeof options.input !== "string" ||
      !options.input.includes('"reclaim-plugin-captures"')
    ) {
      return original(argv, options);
    }
    return original(
      [
        argv[0]!,
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        ...argv.slice(1),
      ],
      {
        ...options,
        onOutputChunk: (chunk, stream) => {
          if (stream === "stdout") {
            onReply?.();
          }
          return options.onOutputChunk?.(chunk, stream);
        },
      },
    );
  });
}
