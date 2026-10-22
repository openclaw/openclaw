import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SpawnResult } from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createNodeWorkerWorkspaceFallback } from "./node-worker-workspace-fallback.js";
import type { WorkerLocalWorkspaceSyncRequest as SyncRequest } from "./tunnel-contract.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runCommandWithTimeout,
}));

const COMMIT = "a".repeat(40);
const ORIGIN = "https://example.invalid/openclaw.git";
const SEED_KEY = "f768fa4834ce38c2cc9d0050df323298de898870b2cf372c95da0a7965dad806";
const MANIFEST_REF = `sha256:${"c".repeat(64)}`;
const REMOTE_WORKSPACE = "/node/workspace";
const INHERITED_NAME = "Gateway";
const INHERITED_EMAIL = "gateway@example.invalid";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type WorkspaceExec = Parameters<typeof createNodeWorkerWorkspaceFallback>[0];

function spawnResult(stdout = "", code = 0): SpawnResult {
  return { stdout, stderr: "", code, signal: null, killed: false, termination: "exit" };
}

const syncResult = {
  mode: "git" as const,
  remoteWorkspaceDir: REMOTE_WORKSPACE,
  manifestRef: MANIFEST_REF,
};
const synced = (seeded = false) => ({ kind: "synced", seeded, result: syncResult });
const commandArgs = (exec: ReturnType<typeof fixture>["exec"]) =>
  exec.mock.calls.map(([c]) => c.argv);
const remoteResult = (stdout = "", code = 0) => ({
  ...spawnResult(stdout, code),
  workspaceDir: REMOTE_WORKSPACE,
});
const isManifestCapture = (argv: readonly string[]) => argv[0] === "node" && !argv.includes("--");
const originStdout = async ({
  argv,
  seed,
}: Pick<Parameters<WorkspaceExec>[0], "argv" | "seed">) => {
  if (seed?.action === "apply") {
    return remoteResult("absent\n");
  }
  if (argv.includes("rev-parse")) {
    return remoteResult(COMMIT);
  }
  return remoteResult(isManifestCapture(argv) ? MANIFEST_REF : "");
};
function fixture(exec = vi.fn<WorkspaceExec>(originStdout)) {
  const request = { localPath: cleanWorkspace(), sessionId: "session-1", generation: 1 };
  const fallback = createNodeWorkerWorkspaceFallback(exec);
  return {
    exec,
    sync: (overrides: Partial<SyncRequest> = {}) =>
      fallback.trySyncWorkspace({ ...request, ...overrides }, MANIFEST_REF),
    finalize: (gitAuthor?: SyncRequest["gitAuthor"]) =>
      fallback.finalizeSync({ ...request, gitAuthor }, syncResult),
  };
}
const seedStoreCommand = {
  argv: ["openclaw-internal-workspace-seed"],
  seed: { action: "store", key: SEED_KEY, maxAgeMs: 6 * 60 * 60 * 1000 },
  timeoutMs: 180_000,
  transportRetry: "never",
};

function cleanWorkspace(): string {
  const root = tempDirs.make("node-worker-origin-workspace-");
  runCommandWithTimeout.mockReset();
  runCommandWithTimeout.mockImplementation(async (argv: string[]) => {
    const args = argv.slice(argv.indexOf("-C") + 2);
    const outputs: Record<string, string> = {
      "rev-parse --show-toplevel": root,
      "status --porcelain=v1 --untracked-files=all": "",
      "rev-parse HEAD": COMMIT,
      "remote get-url origin": ORIGIN,
      "config --get user.name": INHERITED_NAME,
      "config --get user.email": INHERITED_EMAIL,
    };
    const output = outputs[args.join(" ")];
    if (output === undefined) {
      throw new Error(`unexpected local Git command: ${args.join(" ")}`);
    }
    return spawnResult(output);
  });
  return root;
}

describe("node worker workspace origin fallback", () => {
  it.each(["apply", "store"] as const)(
    "preserves source revocation at seed %s",
    async (boundary) => {
      let current = true;
      const closed = new Error("initiating source closed");
      const exec = vi.fn<WorkspaceExec>(async ({ argv, seed }) => {
        if (seed?.action === boundary) {
          current = false;
          throw closed;
        }
        return originStdout({ argv, seed });
      });
      const { sync } = fixture(exec);
      const authorize = () => {
        if (!current) {
          throw closed;
        }
      };
      await expect(sync({ authorize })).rejects.toBe(closed);
      expect(exec.mock.calls.at(-1)?.[0].seed?.action).toBe(boundary);
      if (boundary === "apply") {
        expect(exec).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    { operation: "clone", reason: "clone-failed" },
    { operation: "checkout", reason: "checkout-failed" },
  ] as const)("preserves the $reason fallback", async ({ operation, reason }) => {
    const exec = vi.fn<WorkspaceExec>(async ({ argv }) => ({
      ...spawnResult(argv.includes("rev-parse") ? COMMIT : "", argv.includes(operation) ? 1 : 0),
      workspaceDir: REMOTE_WORKSPACE,
    }));

    await expect(fixture(exec).sync()).resolves.toEqual({ kind: "fallback", reason });
    expect(exec.mock.calls.some(([command]) => command.seed?.action === "store")).toBe(false);
  });

  it.each(["none", "remote-mismatch", "fetch-failed", "manifest-mismatch", "apply-error"] as const)(
    "uses the seed when valid and recovers by cloning after %s",
    async (failure) => {
      let cloned = false;
      const exec = vi.fn<WorkspaceExec>(async ({ argv, seed }) => {
        if (seed?.action === "apply") {
          if (failure === "apply-error") {
            throw new Error("seed copy failed");
          }
          return remoteResult("applied\n");
        }
        if (argv.includes("clone")) {
          cloned = true;
        }
        if (argv.includes("get-url")) {
          return remoteResult(failure === "remote-mismatch" ? "https://other.invalid" : ORIGIN);
        }
        if (!cloned && failure === "manifest-mismatch" && isManifestCapture(argv)) {
          return remoteResult(`sha256:${"d".repeat(64)}`);
        }
        const result = await originStdout({ argv, seed });
        if (!cloned && failure === "fetch-failed" && argv.includes("fetch")) {
          result.code = 1;
        }
        return result;
      });

      const { sync } = fixture(exec);
      await expect(sync()).resolves.toEqual(synced(failure === "none"));
      expect(exec.mock.calls[0]?.[0]).toEqual({
        argv: ["openclaw-internal-workspace-seed"],
        seed: { action: "apply", key: SEED_KEY },
        timeoutMs: 60_000,
        transportRetry: "never",
      });
      expect(cloned).toBe(failure !== "none");
      const commands = exec.mock.calls.map(([command]) => command);
      if (failure === "none") {
        expect(commands[1]?.argv.slice(-3)).toEqual(["remote", "get-url", "origin"]);
        for (const [index, argv] of [
          [2, ["fetch", "--no-tags", "origin", COMMIT]],
          [4, ["checkout", "--detach", "--force", COMMIT]],
        ] as const) {
          expect(commands[index]).toMatchObject({
            argv: expect.arrayContaining([...argv]),
            timeoutMs: 60_000,
            transportRetry: "never",
          });
        }
      } else {
        expect(commands.find((command) => command.argv.includes("clone"))?.resetWorkspace).toBe(
          true,
        );
      }
      expect(commands.filter((command) => command.seed?.action === "store")).toEqual([
        seedStoreCommand,
      ]);
    },
  );

  it("awaits seed storage before releasing the synced workspace and tolerates its failure", async () => {
    const storing = createDeferredCore();
    const stored = createDeferredCore();
    const events: string[] = [];
    const exec = vi.fn<WorkspaceExec>(async ({ argv, seed }) => {
      if (seed?.action === "store") {
        events.push("storing");
        storing.resolve();
        await stored.promise;
        throw new Error("seed cache is full");
      }
      return originStdout({ argv, seed });
    });
    const syncing = fixture(exec)
      .sync()
      .then((outcome) => {
        events.push("synced");
        return outcome;
      });
    await Promise.race([storing.promise, syncing]);
    expect(events).toEqual(["storing"]);
    stored.resolve();
    await expect(syncing).resolves.toMatchObject({ kind: "synced", seeded: false });
    expect(events).toEqual(["storing", "synced"]);
  });

  it.each<[SyncRequest["gitAuthor"], string, string, string[]]>([
    [undefined, INHERITED_NAME, INHERITED_EMAIL, ["user.name", "user.email"]],
    [{ name: "Configured" }, "Configured", INHERITED_EMAIL, ["user.email"]],
    [{ email: "c@example.invalid" }, INHERITED_NAME, "c@example.invalid", ["user.name"]],
    [{ name: "Configured", email: "c@example.invalid" }, "Configured", "c@example.invalid", []],
  ])(
    "projects configured author %j with inherited fields",
    async (gitAuthor, name, email, lookups) => {
      const { exec, finalize } = fixture();
      await expect(finalize(gitAuthor)).resolves.toEqual(syncResult);
      const config = commandArgs(exec).filter((argv) => argv.includes("config"));
      expect(config.map((argv) => argv.slice(-2))).toEqual([
        ["user.name", name],
        ["user.email", email],
        ["remote.origin.url", ORIGIN],
        ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      ]);
      expect(runCommandWithTimeout.mock.calls.map(([argv]) => argv.at(-1))).toEqual([
        ...lookups,
        "origin",
      ]);
    },
  );

  it.each([
    ["http://example.invalid/repo.git", "http://example.invalid/repo.git"],
    ["https://example.invalid/repo.git", "https://example.invalid/repo.git"],
    ["git://127.0.0.1:19418/origin.git", "git://127.0.0.1:19418/origin.git"],
    ["https://user:synthetic@example.invalid/repo.git", undefined],
    ["https://example.invalid/repo.git?token=synthetic", undefined],
    ["https://example.invalid/repo.git#synthetic", undefined],
    ["file:///gateway/repo.git", undefined],
    ["ext::unsupported-helper", undefined],
    ["", undefined],
  ])("forwards only credential-free supported source origins (%s)", async (source, expected) => {
    const { exec, finalize } = fixture();
    runCommandWithTimeout.mockResolvedValue(spawnResult(source));
    await finalize({ name: "Fixture", email: "fixture@example.invalid" });

    expect(
      commandArgs(exec)
        .find((argv) => argv.includes("remote.origin.url"))
        ?.at(-1),
    ).toBe(expected);
  });

  it("fails closed when a node rejects its Gateway Git author", async () => {
    const exec = vi.fn<WorkspaceExec>(async () => ({
      ...remoteResult("", 1),
      stderr: "node Git config rejected the author",
    }));

    await expect(fixture(exec).finalize()).rejects.toThrow(
      "Worker workspace sync failed: node Git config rejected the author",
    );
  });

  it("does not apply Git author configuration to a plain workspace", async () => {
    const exec = vi.fn<WorkspaceExec>();
    const result = { ...syncResult, mode: "plain" as const };
    const localPath = cleanWorkspace();

    await expect(
      createNodeWorkerWorkspaceFallback(exec).finalizeSync(
        { localPath, sessionId: "session-1", generation: 1, gitAuthor: { name: "Configured" } },
        result,
      ),
    ).resolves.toEqual(result);
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects malformed Git authors before inspecting a node workspace", async () => {
    await expect(
      fixture(vi.fn<WorkspaceExec>()).sync({ gitAuthor: { name: "invalid\nname" } }),
    ).rejects.toThrow("Worker workspace Git author metadata is invalid");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });
});
