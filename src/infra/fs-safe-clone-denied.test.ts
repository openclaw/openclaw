// Copies that prefer a clone must survive a kernel that denies the FICLONE ioctl (#164113).
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { FsSafeError } from "./fs-safe.js";
import { copySqliteFile } from "./sqlite-file-copy.js";
import {
  copyUpdateCandidatePluginTrees,
  prepareUpdateCandidatePluginTrees,
} from "./update-candidate-plugin-tree.js";
import { linkUpdateCandidatePluginTrees } from "./update-retained-runtime-tree.js";

// The error fs-safe 0.23 raises inside an unprivileged LXC container whose seccomp
// filter answers ioctl(FICLONE) with EPERM (observed shape, not a guess).
const nativeFailure = (message: string) =>
  new FsSafeError("helper-failed", "native file copy failed", {
    cause: Object.assign(new Error(message), { code: "EPERM" }),
  });

const seccomp = vi.hoisted(() => ({
  failure: undefined as undefined | (() => Error),
  attempts: [] as Array<string | undefined>,
  options: [] as Array<Record<string, unknown> | undefined>,
}));

// The retry may change only the clone mode; every guard must carry over unchanged.
const expectRetryKeepsGuards = () => {
  // Callers may rebuild per-attempt callbacks; compare those by presence, values exactly.
  const [denied, retried] = seccomp.options.map((options) =>
    Object.fromEntries(
      Object.entries(options ?? {})
        .filter(([key]) => key !== "clone")
        .map(([key, value]) => [key, typeof value === "function" ? "function" : value]),
    ),
  );
  expect(retried).toEqual(denied);
};

vi.mock("./fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fs-safe.js")>();
  return {
    ...actual,
    root: async (...args: Parameters<typeof actual.root>) => {
      const opened = await actual.root(...args);
      return new Proxy(opened, {
        get(target, property, receiver) {
          if (property !== "copyIn") {
            return Reflect.get(target, property, receiver);
          }
          return async (...copyArgs: Parameters<typeof opened.copyIn>) => {
            const clone = copyArgs[2]?.clone;
            seccomp.attempts.push(clone);
            seccomp.options.push(copyArgs[2]);
            if (seccomp.failure && (clone === "auto" || clone === "always")) {
              throw seccomp.failure();
            }
            return await target.copyIn(...copyArgs);
          };
        },
      });
    },
  };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  seccomp.failure = undefined;
  seccomp.attempts = [];
  seccomp.options = [];
});

async function fixture() {
  const root = await fs.realpath(dirs.make("retained-runtime-clone-denied-"));
  const source = path.join(root, "source");
  const targetStateDir = path.join(root, "retained");
  const candidateRoot = path.join(root, "candidate");
  const destination = path.join(targetStateDir, "package");
  await fs.mkdir(path.join(source, "node_modules", ".bin"), { recursive: true });
  await fs.mkdir(candidateRoot);
  // .bin launchers are relocated in place, so retention always copies them.
  const launcher = path.join(source, "node_modules", ".bin", "tool");
  await fs.writeFile(launcher, `#!/bin/sh\nexec node "$basedir/../tool/cli.js"\n`);
  await fs.chmod(launcher, 0o755);
  const plan = await prepareUpdateCandidatePluginTrees({
    roots: new Map([[source, destination]]),
    project: (entry) => path.join(destination, path.relative(source, entry)),
    targetStateDir,
    candidateRoot,
  });
  return { destination, plan, targetStateDir, candidateRoot };
}

it("retains the running updater when the clone ioctl is denied", async () => {
  const f = await fixture();
  seccomp.failure = () => nativeFailure("FICLONE: Operation not permitted (os error 1)");

  const result = await linkUpdateCandidatePluginTrees(f.plan, {
    targetStateDir: f.targetStateDir,
    candidateRoot: f.candidateRoot,
    assertCurrent: () => {},
  });

  expect(result.copied).toBe(1);
  expect(seccomp.attempts).toEqual(["auto", "never"]);
  expectRetryKeepsGuards();
  expect(seccomp.options[1]).toMatchObject({ overwrite: false, maxBytes: expect.any(Number) });
  const retained = path.join(f.destination, "node_modules", ".bin", "tool");
  expect((await fs.stat(retained)).mode & 0o777).toBe(0o755);
  expect(await fs.readFile(retained, "utf8")).toContain("exec node");
});

it("copies candidate plugin trees when the clone ioctl is denied", async () => {
  const f = await fixture();
  seccomp.failure = () => nativeFailure("FICLONE: Operation not permitted (os error 1)");

  await copyUpdateCandidatePluginTrees(f.plan, {
    targetStateDir: f.targetStateDir,
    candidateRoot: f.candidateRoot,
  });

  expect(seccomp.attempts).toEqual(["auto", "never"]);
  expectRetryKeepsGuards();
  expect(
    await fs.readFile(path.join(f.destination, "node_modules", ".bin", "tool"), "utf8"),
  ).toContain("exec node");
});

it.each([
  { admission: false, first: "auto" },
  { admission: true, first: "always" },
])(
  "copies SQLite files when the clone ioctl is denied (byte admission=$admission)",
  async ({ admission, first }) => {
    const directory = dirs.make("sqlite-clone-denied-");
    const source = path.join(directory, "source");
    const target = path.join(directory, "target");
    const bytes = Buffer.alloc(32768, 71);
    await fs.writeFile(source, bytes);
    let admitted = 0;
    seccomp.failure = () => nativeFailure("FICLONE: Operation not permitted (os error 1)");

    await copySqliteFile(
      source,
      target,
      await fs.stat(source, { bigint: true }),
      admission ? () => void admitted++ : undefined,
    );

    expect(seccomp.attempts).toEqual([first, "never"]);
    expectRetryKeepsGuards();
    expect(admitted).toBe(admission ? 1 : 0);
    expect(await fs.readFile(target)).toEqual(bytes);
  },
);

it.each([
  { admission: false, first: "auto" },
  { admission: true, first: "always" },
])(
  "does not retry or admit a byte copy for other SQLite copy failures (byte admission=$admission)",
  async ({ admission, first }) => {
    const directory = dirs.make("sqlite-clone-other-failure-");
    const source = path.join(directory, "source");
    await fs.writeFile(source, Buffer.alloc(4096, 7));
    let admitted = 0;
    const failure = nativeFailure("copy_file_range: Operation not permitted (os error 1)");
    seccomp.failure = () => failure;

    await expect(
      copySqliteFile(
        source,
        path.join(directory, "target"),
        await fs.stat(source, { bigint: true }),
        admission ? () => void admitted++ : undefined,
      ),
    ).rejects.toBe(failure);

    expect(seccomp.attempts).toEqual([first]);
    expect(admitted).toBe(0);
    expect(await fs.readdir(directory)).toEqual(["source"]);
  },
);

it("does not retry permission failures that are not a denied clone", async () => {
  const f = await fixture();
  const failure = nativeFailure("copy_file_range: Operation not permitted (os error 1)");
  seccomp.failure = () => failure;

  await expect(
    linkUpdateCandidatePluginTrees(f.plan, {
      targetStateDir: f.targetStateDir,
      candidateRoot: f.candidateRoot,
      assertCurrent: () => {},
    }),
  ).rejects.toBe(failure);
  expect(seccomp.attempts).toEqual(["auto"]);
});
