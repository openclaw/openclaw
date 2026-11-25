import { expect, it } from "vitest";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";

it("preserves async work through nested execution observers and their restoration", async () => {
  const outer = await observeGatewayRunExecution();
  try {
    const inner = await observeGatewayRunExecution();
    try {
      await expect(trackAsyncWork(async () => "nested")).resolves.toBe("nested");
    } finally {
      await inner.restore();
    }
    await expect(trackAsyncWork(async () => "outer")).resolves.toBe("outer");
  } finally {
    await outer.restore();
  }
  await expect(trackAsyncWork(async () => "restored")).resolves.toBe("restored");
});
