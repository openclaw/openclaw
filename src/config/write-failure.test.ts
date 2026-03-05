import { describe, expect, it } from "vitest";
import {
  ConfigWriteTransactionError,
  describeConfigWriteFailure,
  formatConfigWriteFailureForChannel,
  formatConfigWriteFailureForCli,
} from "./write-failure.js";

describe("config write failure formatting", () => {
  it("includes rollback target hash for cli/channel on transaction errors", () => {
    const error = new ConfigWriteTransactionError({
      ok: false,
      transactionId: "tx-1",
      stage: "verify",
      rolledBack: true,
      beforeHash: "abc123def456",
      afterHash: "ff00ee11dd22",
      error: "committed config failed verification",
    });

    const cli = formatConfigWriteFailureForCli(error);
    const channel = formatConfigWriteFailureForChannel(error);

    expect(cli).toContain("Rolled back config version hash=abc123def456");
    expect(channel).toContain("Rolled back config version hash=abc123def456");
  });

  it("parses rollback target hash from legacy transaction messages", () => {
    const details = describeConfigWriteFailure(
      new Error(
        "writeConfigFile transaction failed; stage=verify; rollback=ok; committed config failed verification; rollbackTargetHash=abc123def456;",
      ),
    );

    expect(details).toMatchObject({
      stage: "verify",
      rolledBack: true,
      beforeHash: "abc123def456",
      reason: "committed config failed verification",
    });
  });
});
