import { expect, it, vi, type Mock } from "vitest";
import { installGatewayRunRuntimeHooks } from "./runtime-hooks.js";

export type GatewayLoopStart = (params?: { startupStartedAt?: number }) => Promise<unknown>;
export type GatewayLoopParams = {
  start: GatewayLoopStart;
  beginBoot?: (startedAtMs: number) => Promise<void> | void;
  completeBoot?: (completion: unknown) => void;
  onProcessResourcesSettled?: (outcome: "drained" | "retained") => void;
  onRestartStartupFailure?: (error: unknown, signal: AbortSignal) => Promise<void>;
  ownsProcessLifecycle?: boolean;
};

export function registerGatewayRunCleanupReceiptTests({
  runGatewayCli,
  runGatewayLoop,
}: {
  runGatewayCli: (argv: string[]) => Promise<void>;
  runGatewayLoop: Mock<(params: GatewayLoopParams) => Promise<void>>;
}) {
  it.each(["pre-loop-error", "unconfirmed-return", "drained"] as const)(
    "publishes only an owned cleanup receipt for %s",
    async (phase) => {
      const drained = vi.fn();
      const uninstall = installGatewayRunRuntimeHooks({ onProcessResourcesSettled: drained });
      try {
        if (phase === "pre-loop-error") {
          await expect(
            runGatewayCli(["gateway", "--port", "0", "--token", "test-token"]),
          ).rejects.toThrow("__exit__:1");
          expect(runGatewayLoop).not.toHaveBeenCalled();
        } else {
          runGatewayLoop.mockImplementationOnce(async (params: GatewayLoopParams) => {
            await params.start();
            if (phase === "drained") {
              params.onProcessResourcesSettled?.("drained");
            }
          });
          await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);
        }
        expect(drained).toHaveBeenCalledTimes(phase === "drained" ? 1 : 0);
      } finally {
        uninstall();
      }
    },
  );
}
