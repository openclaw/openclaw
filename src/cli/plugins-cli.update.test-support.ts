import { expect } from "vitest";
import { writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock } from "./plugins-cli-test-helpers.js";

export function expectInstallRecordsWrittenWithLease(records: unknown, config: unknown) {
  expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).toHaveBeenCalledWith(
    records,
    expect.objectContaining({
      config,
      filePath: expect.any(String),
      lease: expect.anything(),
    }),
  );
}

export function writtenIndexCustody() {
  const options =
    writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mock.calls.at(-1)?.[1];
  if (!options) {
    throw new Error("expected an index write before registry refresh");
  }
  return {
    filePath: options.filePath,
    lease: {
      ...options.lease,
      // Refresh wraps the guards while retaining the original lease owner and signal.
      assertOwned: expect.any(Function),
      assertOwnedInTransaction: expect.any(Function),
    },
  };
}
