import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { inspectManagedProcessGroup } from "../../scripts/lib/managed-child-process.mts";

const mocks = vi.hoisted(() => ({
  rename: vi.fn(),
  rm: vi.fn(),
  readdir: vi.fn(),
  read: vi.fn(),
  inspect: vi.fn<typeof inspectManagedProcessGroup>(),
  deleteClaim: vi.fn(),
  closeDatabase: vi.fn(),
  verifyCleanup: vi.fn(),
}));
vi.mock("node:fs", () => ({ readdirSync: mocks.readdir, readFileSync: mocks.read }));
vi.mock("node:fs/promises", () => ({ default: { rename: mocks.rename, rm: mocks.rm } }));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    prepare() {
      return { run: mocks.deleteClaim };
    }
    close = mocks.closeDatabase;
  },
}));
vi.mock("../../scripts/lib/managed-child-process.mts", () => ({
  inspectManagedProcessGroup: mocks.inspect,
}));
vi.mock("./sqlite-busy-timeout.js", () => ({ setSqliteBusyTimeout: vi.fn() }));
vi.mock("./triage-lease-fixture.test-support.js", () => ({ triageLeaseFixtureLifetime: mocks }));
import { cleanupTriageBoundary } from "./triage-boundary-cleanup.test-support.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rename.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
  mocks.readdir.mockReturnValue(["child-receipt"]);
  mocks.read.mockReturnValue("41002");
  mocks.inspect.mockReturnValue("dead");
  mocks.verifyCleanup.mockImplementation((body: () => Promise<void>) => body());
  vi.spyOn(vi, "waitFor").mockImplementation(async (body) => body());
});
afterEach(() => vi.restoreAllMocks());

type CleanupCase = {
  name: string;
  platform?: NodeJS.Platform;
  code?: string;
  state?: ReturnType<typeof inspectManagedProcessGroup>;
  unpublished?: boolean;
  childError?: boolean;
  succeeds?: boolean;
};

it.each<CleanupCase>([
  { name: "Darwin EPERM followed by full group death", succeeds: true },
  { name: "Darwin EPERM with a live group", state: "live" },
  { name: "Darwin EPERM with indeterminate group state", state: "indeterminate" },
  { name: "Darwin EPERM with an unpublished detached launch", unpublished: true },
  { name: "Darwin non-EPERM signal failure", code: "EACCES" },
  { name: "non-Darwin EPERM", platform: "linux" },
  { name: "Darwin EPERM with another child cleanup failure", childError: true },
])(
  "preserves cleanup ownership: $name",
  async ({
    platform = "darwin",
    code = "EPERM",
    state = "dead",
    unpublished = false,
    childError = false,
    succeeds = false,
  }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const signalError = Object.assign(new Error("synthetic signal result"), { code });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw signalError;
    });
    mocks.inspect.mockReturnValue(state);
    if (unpublished) {
      mocks.read.mockReturnValue("");
    }
    const helper = new ChildProcess();
    Object.defineProperties(helper, {
      pid: { value: 41001 },
      exitCode: { value: 0 },
    });
    const parent = new ChildProcess();
    Object.defineProperty(parent, "exitCode", { value: childError ? null : 0 });
    vi.spyOn(parent, "kill").mockImplementation(() => {
      throw new Error("synthetic child kill failure");
    });
    const close = vi.fn();
    const cleanup = cleanupTriageBoundary({
      root: "/synthetic/triage",
      groups: "/synthetic/triage/groups",
      helper,
      parent,
      exit: Promise.resolve(),
      parentExit: Promise.resolve(),
      lines: { close },
      readEvents: async () => [],
      databasePath: "/synthetic/coordinator.sqlite",
    });
    if (succeeds) {
      await expect(cleanup).resolves.toBeUndefined();
      expect(mocks.deleteClaim).toHaveBeenCalledWith("/synthetic/triage");
      expect(mocks.rm).toHaveBeenCalledWith("/synthetic/triage", { recursive: true, force: true });
    } else {
      const failure = await cleanup.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cause: signalError,
            message: expect.stringContaining("41001 (receipt helper)"),
          }),
        ]),
      );
      expect(mocks.deleteClaim).not.toHaveBeenCalled();
      expect(mocks.rm).not.toHaveBeenCalled();
    }
    expect(kill).toHaveBeenCalledWith(-41001, "SIGKILL");
    expect(mocks.verifyCleanup).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  },
);
