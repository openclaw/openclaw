import fs from "node:fs/promises";
import path from "node:path";
import { createGatewaySuiteHarness } from "./test-helpers.server.js";

let historyHarness: Awaited<ReturnType<typeof createGatewaySuiteHarness>> | undefined;

export async function writeResetArchiveTranscript(params: {
  dir: string;
  sessionId: string;
  timestamp: string;
  texts: string[];
}) {
  await fs.writeFile(
    path.join(params.dir, `${params.sessionId}.jsonl.reset.${params.timestamp}`),
    [
      JSON.stringify({ type: "session", version: 1, id: params.sessionId }),
      ...params.texts.map((text) =>
        JSON.stringify({
          message: { role: "assistant", content: [{ type: "text", text }] },
        }),
      ),
    ].join("\n"),
    "utf-8",
  );
}

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
