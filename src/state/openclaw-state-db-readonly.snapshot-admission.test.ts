import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  assertCurrent: vi.fn<() => void>(),
  assertFresh: vi.fn<() => void>(),
  prepare: vi.fn(),
  cleanup: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("./openclaw-state-db-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-db-cache.js")>();
  return {
    ...actual,
    captureOpenClawStateDatabaseReadAdmission: mocks.capture,
    registerOpenClawStateDatabaseAsyncResource: () => () => {},
    openClawStateDatabaseCache: {
      ...actual.openClawStateDatabaseCache,
      assertOpenClawStateDatabaseFreshOpenAllowedAtPath: mocks.assertFresh,
    },
  };
});
vi.mock("../infra/sqlite-snapshot-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-snapshot-source.js")>()),
  prepareSqliteReadOnlyLocation: mocks.prepare,
}));

import { withOpenClawStateDatabaseReadSnapshot } from "./openclaw-state-db-readonly.js";

beforeEach(() => {
  mocks.assertCurrent.mockReset();
  mocks.assertFresh.mockReset();
  mocks.cleanup.mockReset().mockResolvedValue(true);
  mocks.capture.mockReset().mockReturnValue({ identity: {}, assertCurrent: mocks.assertCurrent });
  mocks.prepare.mockReset().mockResolvedValue({
    location: "/fixture/private.sqlite",
    cleanupAsync: mocks.cleanup,
  });
});

it("retains discovery context when capturing read admission fails", async () => {
  await withTempDir("openclaw-discovery-admission-", async (root) => {
    const source = path.join(root, "source");
    fs.writeFileSync(source, "mock snapshot source; never opened as SQLite");
    const failure = new Error("synthetic admission refusal");
    mocks.capture.mockImplementation(() => {
      throw failure;
    });
    const operation = vi.fn(async () => 1);
    await expect(
      withOpenClawStateDatabaseReadSnapshot(operation, { path: source }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(`Cannot read shared state for discovery: ${source}`),
      cause: failure,
    });
    expect(operation).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});

it("preserves a precise source failure and cleans its prepared snapshot before callback admission", async () => {
  await withTempDir("openclaw-discovery-precedence-", async (root) => {
    const source = path.join(root, "source");
    fs.writeFileSync(source, "mock snapshot source; never opened as SQLite");
    const failure = new Error("synthetic readonly verification failure");
    mocks.prepare.mockImplementation(async () => {
      mocks.assertFresh.mockImplementation(() => {
        throw failure;
      });
      mocks.assertCurrent.mockImplementation(() => {
        throw new Error("read admission changed");
      });
      return { location: "/fixture/private.sqlite", cleanupAsync: mocks.cleanup };
    });
    const operation = vi.fn(async () => 1);
    await expect(withOpenClawStateDatabaseReadSnapshot(operation, { path: source })).rejects.toBe(
      failure,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });
});
