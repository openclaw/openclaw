import { beforeEach, describe, expect, it, vi } from "vitest";

const hasAnyAuthProfileStoreSourceMock = vi.fn(() => false);

vi.mock("../../agents/auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: hasAnyAuthProfileStoreSourceMock,
}));

import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  resolveSessionAuthSelectionMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn auth-profile cold path", () => {
  setupRunCronIsolatedAgentTurnSuite();

  beforeEach(() => {
    hasAnyAuthProfileStoreSourceMock.mockReset();
    hasAnyAuthProfileStoreSourceMock.mockReturnValue(false);
  });

  it("skips auth-profile override resolution when no sources exist", async () => {
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("ok");
    expect(hasAnyAuthProfileStoreSourceMock).toHaveBeenCalledTimes(1);
    expect(resolveSessionAuthSelectionMock).not.toHaveBeenCalled();
  });
});
