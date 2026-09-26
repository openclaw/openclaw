import { createGatewaySuiteHarness } from "./test-helpers.server.js";

let historyHarness: Awaited<ReturnType<typeof createGatewaySuiteHarness>> | undefined;

export async function closeHistoryHarness() {
  await historyHarness?.close();
  historyHarness = undefined;
}

export async function withGatewayHarness<T>(
  run: (harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>) => Promise<T>,
  options: { fresh?: boolean } = {},
) {
  if (options.fresh) {
    await closeHistoryHarness();
  }
  historyHarness ??= await createGatewaySuiteHarness({
    serverOptions: { auth: { mode: "none" } },
  });
  let completed = false;
  try {
    const result = await run(historyHarness);
    completed = true;
    return result;
  } finally {
    if (!completed || options.fresh) {
      await closeHistoryHarness();
    }
  }
}
