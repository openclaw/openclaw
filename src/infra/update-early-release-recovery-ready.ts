/** The early release recovery's readiness wait (see `update-early-release-recovery.ts`). */

/** The runner's command runner, as far as reading `systemctl show` needs it. */
type SystemctlShow = (argv: string[]) => Promise<{ output: string }>;

/** A boot migration of a large agent database runs before the Gateway reports ready. */
const READY_TIMEOUT_MS = 20 * 60_000;

/**
 * Waits for `probe` (the Gateway's `/readyz`). A migrating Gateway stays up while it works. One
 * that keeps exiting before it serves gives up when its unit fails (the start limit, or an exit
 * systemd does not restart), or once systemd restarted it as often as that limit allows starts:
 * a boot that crashes later than the limit's window allows never reaches the limit itself.
 */
export async function waitForGatewayReady(
  unit: string,
  probe: () => Promise<boolean>,
  { run, now, log }: { run: SystemctlShow; now: () => number; log: (line: string) => void },
): Promise<boolean> {
  const show = async (key: string) =>
    (
      await run(["systemctl", "--user", "show", `--property=${key}`, "--value", unit])
    ).output.trim();
  const restartCount = async () => Number(await show("NRestarts")) || 0;
  // The installed Gateway unit's burst, when systemd does not report one.
  const burst = Number(await show("StartLimitBurst")) || 10;
  let first = await restartCount();
  const until = now() + READY_TIMEOUT_MS;
  while (now() < until) {
    if (await probe()) {
      return true;
    }
    const [state, restarts] = [await show("ActiveState"), await restartCount()];
    // A start that is not systemd's own restart resets the count.
    first = Math.min(first, restarts);
    if (state === "failed" || restarts - first >= burst) {
      const result = state === "failed" ? await show("Result") : "";
      log(`${unit} ${result ? `failed (${result})` : `restarted ${restarts - first} times`}`);
      return false;
    }
  }
  return false;
}
