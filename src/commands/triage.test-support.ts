import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, vi, type Mock } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { hasErrnoCode } from "../infra/errno.js";
import type { UpdateRepairInferenceResult } from "../infra/update-repair-inference.js";

export function useTriageHeadlessFixture() {
  let receipts: Awaited<ReturnType<typeof openFixtureReceiptChannel>>;
  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await receipts.close();
  });
  return async (executablePath: string, pidPath: string) => {
    await fs.writeFile(
      executablePath,
      `#!/usr/bin/env node
${fixtureReceiptClientSource(receipts.endpoint)}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
sendReceipt(${JSON.stringify(pidPath)}, "ready");
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    return async (operation: PromiseLike<unknown>, signal: AbortSignal): Promise<number> => {
      const readReadyPid = async () =>
        Number(
          await fs.readFile(pidPath, "utf8").catch((error: unknown) => {
            if (hasErrnoCode(error, "ENOENT")) {
              return "";
            }
            throw error;
          }),
        );
      // Receipt and command completion use different pipes. The fixture records its PID
      // before reporting readiness, so the durable record decides when completion wins.
      const settled = Promise.resolve(operation).then(
        async () => {
          expect(await readReadyPid()).toBeGreaterThan(0);
        },
        async (error: unknown) => {
          if (!((await readReadyPid()) > 0)) {
            throw error;
          }
        },
      );
      await withinTest(Promise.race([receipts.waitFor(pidPath, "ready"), settled]), signal);
      return readReadyPid();
    };
  };
}

export function createTriageInferenceSelection(stateDir: string): UpdateRepairInferenceResult {
  return {
    ok: true,
    route: {
      runner: "embedded",
      agentId: "main",
      provider: "fixture",
      model: "repair",
      modelLabel: "fixture/repair",
      agentDir: path.join(stateDir, "agents/main/agent"),
      runConfig: {},
      sourceConfig: {},
    },
    modelFallbacks: [],
  };
}

export function resetTriageRepairRuntimeMocks(
  mocks: {
    prepareUpdateRepairInference: Mock;
    runUpdateRepairTurn: Mock;
    runUpdateRepairLoop: Mock;
  },
  stateDir: string,
) {
  mocks.runUpdateRepairLoop.mockResolvedValue({
    status: "repaired",
    attempts: [],
    finalValidation: { ok: true, score: 0, summary: "Doctor lint reports no errors." },
  });
  mocks.prepareUpdateRepairInference
    .mockReset()
    .mockResolvedValue(createTriageInferenceSelection(stateDir));
  mocks.runUpdateRepairTurn.mockReset().mockResolvedValue({
    status: "completed",
    toolCalls: 0,
    envelope: { status: "ok", final: "Repair completed." },
  });
}

export function createTriageRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeStdout: vi.fn(), writeJson: vi.fn() };
}

export async function withTriageTerminal(interactive: boolean, run: () => Promise<void>) {
  const streams = [process.stdin, process.stdout];
  const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  for (const stream of streams) {
    Object.defineProperty(stream, "isTTY", { configurable: true, value: interactive });
  }
  try {
    await run();
  } finally {
    streams.forEach((stream, index) => {
      const descriptor = descriptors[index];
      if (descriptor) {
        Object.defineProperty(stream, "isTTY", descriptor);
      } else {
        Reflect.deleteProperty(stream, "isTTY");
      }
    });
  }
}
