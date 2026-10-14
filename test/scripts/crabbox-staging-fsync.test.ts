import { spawnSync } from "node:child_process";
import {
  existsSync,
  fstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
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
let root: string;
let repository: string;
beforeAll(() => {
  root = temporary.make("openclaw-staging-fsync-");
  repository = join(root, "repository");
  mkdirSync(repository);
  const initialized = spawnSync("git", ["init", "--quiet", "--template=", repository], {
    env: createNestedGitEnv(),
    encoding: "utf8",
  });
  expect(initialized.status, initialized.stderr).toBe(0);
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
] as const)(
  "records unsupported %s fsync during %s once, protects recovery, and allows live cleanup",
  async (kind, phase) => {
    vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
    let unsupported = false;
    let armed = phase === "create";
    fsync.mockImplementation((fd) => {
      if (unsupported) {
        throw Object.assign(new Error("fsync retried after an unsupported result"), {
          code: "EIO",
        });
      }
      if (armed && fstatSync(fd)[kind]()) {
        unsupported = true;
        throw Object.assign(new Error("fixture fsync unsupported"), { code: "EINVAL" });
      }
    });
    const owner = createStaging(join(root, "staging"), repository);
    const source = join(owner.payload, "source");
    mkdirSync(source);
    writeFileSync(join(source, "source.txt"), "retained source\n");
    armed = true;
    owner.prepared({ files: [], deleted: [] });
    const receipt = JSON.parse(readFileSync(join(owner.root, "staging.json"), "utf8"));
    expect(unsupported).toBe(true);
    expect(receipt).toMatchObject({ durable: false, state: "prepared" });

    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === process.pid && signal === 0) {
        throw Object.assign(new Error("fixture producer exited"), { code: "ESRCH" });
      }
      return kill(pid, signal);
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(
      await runStagingCommand(["recover", receipt.id], join(root, "staging"), {
        binary: "unused-crabbox",
        cwd: repository,
      }),
    ).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({
      recovered: false,
      reason: expect.stringContaining("durable recovery metadata is incomplete"),
    });
    expect(readFileSync(join(source, "source.txt"), "utf8")).toBe("retained source\n");
    expect(existsSync(join(owner.root, "recovery.lock"))).toBe(false);

    owner.admitted();
    owner.settled();
    owner.preserved(preserveCrabboxArtifacts(source, repository)!);
    expect(JSON.parse(readFileSync(join(owner.root, "staging.json"), "utf8"))).toMatchObject({
      durable: false,
      state: "preserved",
    });
    owner.dispose();
    expect(existsSync(owner.root)).toBe(false);
  },
);

it.skipIf(process.platform === "win32")("still reports an initial fsync I/O failure", () => {
  const failure = Object.assign(new Error("fixture storage failure"), { code: "EIO" });
  fsync.mockImplementation(() => {
    throw failure;
  });
  const staging = join(root, "io-failure");
  expect(() => createStaging(staging, repository)).toThrow(failure);
  expect(readdirSync(staging)).toEqual([]);
});
