/**
 * Cron Vitest projects can spend several minutes importing the full module graph
 * before the first test prints output. CI treats extended silence as a stalled
 * Vitest process; emit a lightweight stderr heartbeat during setup/teardown.
 */
export default async function cronVitestGlobalSetup() {
  const intervalMs = 45_000;
  const id = setInterval(() => {
    process.stderr.write(`[cron-vitest-keepalive] ${Date.now()}\n`);
  }, intervalMs);
  return async () => {
    clearInterval(id);
  };
}
