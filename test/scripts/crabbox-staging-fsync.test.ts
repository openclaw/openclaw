import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { preserveCrabboxArtifacts } from "../../scripts/crabbox-staging-artifacts.mts";
import { createStaging, runStagingCommand } from "../../scripts/crabbox-staging.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const { fsync } = vi.hoisted(() => ({ fsync: vi.fn<(fd: number) => void>() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  fsyncSync: fsync,
}));

const temporary = useAutoCleanupTempDirTracker(afterAll);
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
const receiptAt = (root: string) => JSON.parse(fs.readFileSync(join(root, "staging.json"), "utf8"));
const root = temporary.make("openclaw-staging-fsync-");
const repository = join(root, "repository");
beforeAll(() => {
  execFileSync("git", ["init", "--quiet", "--template=", repository], {
    env: createNestedGitEnv(),
    stdio: "pipe",
  });
});
afterEach(() => {
  fsync.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.skipIf(process.platform === "win32").each([
  ["isDirectory", "create"],
  ["isFile", "create"],
  ["isDirectory", "prepare"],
  ["isFile", "prepare"],
] as const)("handles unsupported %s fsync at %s", async (kind, phase) => {
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  let unsupported = false;
  let armed = phase === "create";
  fsync.mockImplementation((fd) => {
    if (unsupported) {
      throw failure("EIO", "fsync retried after an unsupported result");
    }
    if (armed && fs.fstatSync(fd)[kind]()) {
      unsupported = true;
      throw failure("EINVAL", "fixture fsync unsupported");
    }
  });
  const owner = createStaging(join(root, "staging"), repository);
  const source = join(owner.payload, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(join(source, "source.txt"), "retained source\n");
  armed = true;
  owner.prepared({ files: [], deleted: [] });
  const receipt = receiptAt(owner.root);
  expect(unsupported).toBe(true);
  expect(receipt).toMatchObject({ durable: false, state: "prepared" });

  const kill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === process.pid && signal === 0) {
      throw failure("ESRCH", "fixture producer exited");
    }
    return kill(pid, signal);
  });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const recovered = await runStagingCommand(["recover", receipt.id], join(root, "staging"), {
    binary: "unused-crabbox",
    cwd: repository,
  });
  expect(recovered).toBe(1);
  expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({
    recovered: false,
    reason: expect.stringContaining("durable recovery metadata is incomplete"),
  });
  expect(fs.readFileSync(join(source, "source.txt"), "utf8")).toBe("retained source\n");
  expect(fs.existsSync(join(owner.root, "recovery.lock"))).toBe(false);

  owner.admitted();
  owner.settled();
  owner.preserved(preserveCrabboxArtifacts(source, repository)!);
  expect(receiptAt(owner.root)).toMatchObject({ durable: false, state: "preserved" });
  owner.dispose();
  expect(fs.existsSync(owner.root)).toBe(false);
});

it.skipIf(process.platform === "win32")("still reports an initial fsync I/O failure", () => {
  const error = failure("EIO", "fixture storage failure");
  fsync.mockImplementation(() => {
    throw error;
  });
  const staging = join(root, "io-failure");
  expect(() => createStaging(staging, repository)).toThrow(error);
  expect(fs.readdirSync(staging)).toEqual([]);
});
