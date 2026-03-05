import { describe, expect, it } from "vitest";
import {
  commitConfigWriteTransactionOrThrow as commitFromConfig,
  writeConfigFile as writeFromConfig,
} from "./config.js";
import {
  commitConfigWriteTransactionOrThrow as commitFromTransaction,
  writeConfigFile as writeFromTransaction,
} from "./transaction.js";

describe("config barrel exports", () => {
  it("re-exports transaction-aware write helpers from transaction module", () => {
    expect(writeFromConfig).toBe(writeFromTransaction);
    expect(commitFromConfig).toBe(commitFromTransaction);
  });
});
