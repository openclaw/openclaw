import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  desktopProofAssets,
  desktopProofCommit,
  desktopProofSource,
  desktopProofSshdFailure,
  desktopProofTestReport,
  desktopResizeStages,
  exportDesktopResizeProof,
  inspectDesktopSshdRuntimeDirectory,
  prepareDesktopSshdRuntimeDirectory,
  readDesktopProofPhase,
  readDesktopProofTestReport,
  sanitizeDesktopResizeProof,
  withDesktopProofCleanup,
} from "../../scripts/lib/desktop-resize-proof.mts";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const head = "a".repeat(40);
const base = "b".repeat(40);
const merge = "c".repeat(40);
const tree = "d".repeat(40);
const size = { width: 1200, height: 850 };
const assets = { "index-fixture.js": "e".repeat(64) };
const rawTestReport = (message = "AssertionError: private-token") => ({
  success: true,
  numTotalTests: 1,
  numFailedTests: 1,
  numFailedTestSuites: 1,
  snapshot: { private: "secret" },
  testResults: [
    {
      name: "/private/workspace/ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
      status: "failed",
      message: "",
      assertionResults: [
        {
          title: "private-title",
          fullName: "private-title",
          status: "failed",
          location: { line: 120, column: 3 },
          meta: { desktopProofPhase: "node-admission", password: "private-token" },
          failureMessages: [message],
        },
      ],
    },
  ],
});
const proof = (carrier: "node" | "ssh" = "node") => ({
  carrier,
  gateway: { execution: "built-process", readiness: "readyz", minimal: false },
  node:
    carrier === "node"
      ? {
          deviceId: "private-node-id",
          passwordAbsentFromObserve: true,
          disconnectClosedViewer: true,
        }
      : null,
  observer: {
    evidence: "endpoint-marker-brackets",
    keyboardForwardedBytes: 0,
    resizeForwardedBytes: 0,
  },
  assets,
  samples: desktopResizeStages.map((stage) => ({ stage, ...size })),
  pixels: { distinctSampledColors: 100 },
  provenance: { privatePath: "/private/fixture" },
  hello: { token: "private-token" },
});

describe("desktop proof identity and public evidence", () => {
  it("keeps the UI phase contract narrower than arbitrary reporter strings", () => {
    type Phase = Exclude<
      ReturnType<typeof desktopProofTestReport>["files"][number]["assertions"][number]["phase"],
      "unknown"
    >;
    expectTypeOf<"node-admission">().toExtend<Phase>();
    expectTypeOf<"file-loaded">().toExtend<Phase>();
    expectTypeOf<"unknown">().not.toExtend<Phase>();
    expectTypeOf<"misspelled-phase">().not.toExtend<Phase>();
  });

  it("records sshd runtime directory facts without modifying missing or unsafe paths", async () => {
    const root = dirs.make("desktop-sshd-runtime-");
    const directory = path.join(root, "runtime");
    expect(await inspectDesktopSshdRuntimeDirectory(directory)).toEqual({
      status: "missing",
      symlink: null,
      directory: null,
      rootOwned: null,
      groupOrWorldWritable: null,
    });
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(directory, { mode: 0o700 });
    expect(await inspectDesktopSshdRuntimeDirectory(directory)).toMatchObject({
      status: "present",
      symlink: false,
      directory: true,
      rootOwned: (await stat(directory)).uid === 0,
      groupOrWorldWritable: process.platform === "win32" ? expect.any(Boolean) : false,
    });
    const link = path.join(root, "runtime-link");
    await symlink(directory, link, "dir");
    expect(await inspectDesktopSshdRuntimeDirectory(link)).toMatchObject({
      symlink: true,
      directory: true,
    });
    if (process.platform !== "win32") {
      await chmod(directory, 0o770);
      expect(await inspectDesktopSshdRuntimeDirectory(directory)).toMatchObject({
        groupOrWorldWritable: true,
      });
      expect((await stat(directory)).mode & 0o777).toBe(0o770);
    }
    const file = path.join(root, "not-a-directory");
    await writeFile(file, "private contents");
    expect(await inspectDesktopSshdRuntimeDirectory(file)).toMatchObject({ directory: false });
  });

  it("creates a missing sshd runtime directory once and verifies the resulting security facts", async () => {
    const missing = {
      status: "missing",
      symlink: null,
      directory: null,
      rootOwned: null,
      groupOrWorldWritable: null,
    };
    const ready = {
      status: "present",
      symlink: false,
      directory: true,
      rootOwned: true,
      groupOrWorldWritable: false,
    };
    const events: string[] = [];
    let current: Awaited<ReturnType<typeof inspectDesktopSshdRuntimeDirectory>> = missing;
    const create = vi.fn(async () => {
      events.push("create");
      current = ready;
    });
    const inspect = async () => {
      events.push("inspect");
      return current;
    };
    expect(await prepareDesktopSshdRuntimeDirectory(inspect, create)).toEqual({
      before: missing,
      after: ready,
      created: true,
    });
    expect(events).toEqual(["inspect", "create", "inspect"]);
    expect(create).toHaveBeenCalledTimes(1);
    events.length = 0;
    expect(await prepareDesktopSshdRuntimeDirectory(inspect, create)).toEqual({
      before: ready,
      after: ready,
      created: false,
    });
    expect(events).toEqual(["inspect"]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      status: "missing",
      symlink: true,
      directory: null,
      rootOwned: null,
      groupOrWorldWritable: null,
    },
    {
      status: "unavailable",
      symlink: null,
      directory: null,
      rootOwned: null,
      groupOrWorldWritable: null,
    },
    {
      status: "present",
      symlink: true,
      directory: true,
      rootOwned: true,
      groupOrWorldWritable: false,
    },
    {
      status: "present",
      symlink: false,
      directory: false,
      rootOwned: true,
      groupOrWorldWritable: false,
    },
    {
      status: "present",
      symlink: false,
      directory: true,
      rootOwned: false,
      groupOrWorldWritable: false,
    },
    {
      status: "present",
      symlink: false,
      directory: true,
      rootOwned: true,
      groupOrWorldWritable: true,
    },
  ])("refuses unsafe existing sshd runtime facts without mutation (%#)", async (facts) => {
    const create = vi.fn(async () => undefined);
    await expect(prepareDesktopSshdRuntimeDirectory(async () => facts, create)).rejects.toThrow(
      "Unsafe or unavailable",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses invalid sshd creation and preserves a concurrent-path creation error", async () => {
    const missing = {
      status: "missing",
      symlink: null,
      directory: null,
      rootOwned: null,
      groupOrWorldWritable: null,
    };
    const unsafe = {
      status: "present",
      symlink: false,
      directory: true,
      rootOwned: false,
      groupOrWorldWritable: false,
    };
    const inspect = vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce(unsafe);
    const create = vi.fn(async () => undefined);
    await expect(prepareDesktopSshdRuntimeDirectory(inspect, create)).rejects.toThrow(
      "Unsafe or unavailable",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(2);
    const conflict = Object.assign(new Error("path already exists"), { code: "EEXIST" });
    const racedCreate = vi.fn(async () => {
      throw conflict;
    });
    await expect(prepareDesktopSshdRuntimeDirectory(async () => missing, racedCreate)).rejects.toBe(
      conflict,
    );
    expect(racedCreate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Missing privilege separation directory: /private/runtime\r\n", "privsep-directory-missing"],
    [
      "/private/runtime must be owned by root and not group or world-writable.\r\n",
      "privsep-directory-permissions",
    ],
    ["Privilege separation user private-user does not exist\r\n", "privsep-user-missing"],
    ["sshd: no hostkeys available -- exiting.\n", "host-key-unavailable"],
    ["private config failed at private path", "unclassified"],
    ["x".repeat(64 * 1024 + 1), "output-too-large"],
  ])("exports only a fixed sshd failure category (%#)", (stderr, category) => {
    expect(desktopProofSshdFailure(stderr)).toBe(category);
    expect(desktopProofSshdFailure(stderr)).not.toMatch(/private|runtime|user$/u);
  });

  it("preserves the sshd command failure and private log write when projection fails", async () => {
    const child = new Error("sshd-config failed");
    const projection = new Error("projection failed");
    const recorded: unknown[] = [];
    const record = (error: unknown) => {
      recorded.push(error);
    };
    let privateLogSaved = false;
    const failure = await withDesktopProofCleanup(
      async () => {
        throw child;
      },
      () =>
        withDesktopProofCleanup(
          async () => {
            expect(recorded[0]).toBe(child);
            throw projection;
          },
          async () => {
            privateLogSaved = true;
          },
          record,
        ),
      record,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(child);
    expect((failure as AggregateError).errors[1].errors[0]).toBe(projection);
    expect(privateLogSaved).toBe(true);
  });

  it("publishes fixed phases and known failure locations, not raw reporter content", () => {
    const result = desktopProofTestReport(
      rawTestReport(
        "AssertionError: private-token actual=secret expected=password\n at /private/workspace/test/e2e/qa-lab/runtime/skill-library-node-process.ts:42:9\n at /private/secret.ts:1:2\n https://private.invalid/token",
      ),
    );
    expect(result).toMatchObject({
      failedTests: 1,
      files: [
        {
          file: "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
          assertions: [
            {
              index: 0,
              phase: "node-admission",
              declarationLocation: { line: 120, column: 3 },
              failures: [
                {
                  category: "AssertionError",
                  failureLocations: [
                    {
                      file: "test/e2e/qa-lab/runtime/skill-library-node-process.ts",
                      line: 42,
                      column: 9,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private|token|secret|password|actual|expected|success|title|https/u,
    );
  });

  it.each([
    ["Error: Test timed out in 120000ms.\nprivate pending operation", "test-timeout"],
    ["Error: Test timed out in 120000ms while waiting for private operation.", "test-timeout"],
    ["Error: Hook timed out in 60000ms.\nprivate pending operation", "hook-timeout"],
    ["Error: a timeout might have happened after 174000ms", "test-error"],
  ])("classifies only the emitted timeout contract: %s", (message, category) => {
    const result = desktopProofTestReport(rawTestReport(message));
    expect(result.files[0]?.assertions[0]?.failures[0]?.category).toBe(category);
  });

  it("rejects unknown report files and excessive counts, and ignores unknown metadata phases", () => {
    const report = rawTestReport();
    report.testResults[0]!.assertionResults[0]!.meta.desktopProofPhase = "private-token";
    expect(desktopProofTestReport(report).files[0]?.assertions[0]?.phase).toBe("unknown");
    expect(() => desktopProofTestReport({ ...report, numTotalTests: 17 })).toThrow();
    report.testResults[0]!.name = "/private/other.test.ts";
    expect(() => desktopProofTestReport(report)).toThrow();
  });

  it("retains the observed phase and child timeout when the terminal report is missing and export fails", async () => {
    const root = dirs.make("desktop-report-failure-");
    const checkpoint = path.join(root, "desktop-phase.json");
    await writeFile(checkpoint, JSON.stringify({ lastObservedPhase: "node-admission" }));
    const child = Object.assign(new Error("test-node failed"), { code: "ETIMEDOUT" });
    const exporting = new Error("export failed");
    let lastObserved: Awaited<ReturnType<typeof readDesktopProofPhase>> | undefined;
    const recorded: unknown[] = [];
    const record = (error: unknown) => {
      recorded.push(error);
    };
    const failure = await withDesktopProofCleanup(
      async () => {
        throw child;
      },
      () =>
        withDesktopProofCleanup(
          async () => {
            expect(recorded[0]).toBe(child);
            lastObserved = await readDesktopProofPhase(checkpoint);
            await readDesktopProofTestReport(path.join(root, "missing.json"));
          },
          async () => {
            throw exporting;
          },
          record,
        ),
      record,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0]).toBe(child);
    expect(aggregate.errors[1].errors[0]).toMatchObject({ code: "ENOENT" });
    expect(aggregate.errors[1].errors[1]).toBe(exporting);
    expect(lastObserved).toEqual({
      status: "available",
      lastObservedPhase: "node-admission",
      owners: null,
    });
  });

  it("projects only known phases from bounded regular checkpoints", async () => {
    const root = dirs.make("desktop-private-phase-");
    const file = path.join(root, "desktop-phase.json");
    expect(await readDesktopProofPhase(file)).toEqual({
      status: "unavailable",
      lastObservedPhase: null,
      owners: null,
    });
    await writeFile(file, JSON.stringify({ lastObservedPhase: "file-loaded", secret: "private" }));
    expect(await readDesktopProofPhase(file)).toEqual({
      status: "available",
      lastObservedPhase: "file-loaded",
      owners: null,
    });
    const link = path.join(root, "linked-phase.json");
    await symlink(file, link);
    expect(await readDesktopProofPhase(link)).toEqual({
      status: "invalid",
      lastObservedPhase: null,
      owners: null,
    });
    expect(await readDesktopProofPhase(root)).toEqual({
      status: "invalid",
      lastObservedPhase: null,
      owners: null,
    });
    for (const content of ["{", '{"lastObservedPhase":"private-token"}', "x".repeat(1025)]) {
      await writeFile(file, content);
      expect(await readDesktopProofPhase(file)).toEqual({
        status: "invalid",
        lastObservedPhase: null,
        owners: null,
      });
    }
  });

  it("projects explicit resource ownership without inferring detached-process cleanup", async () => {
    const root = dirs.make("desktop-process-ownership-");
    const file = path.join(root, "desktop-phase.json");
    for (const gateway of ["not-started", "owned", "closed"] as const) {
      await writeFile(
        file,
        JSON.stringify({
          lastObservedPhase: "gateway-start",
          owners: { gateway, endpointTap: "owned", privatePath: "/private/fixture" },
          startupAtAbort: { currentPhase: "private-token" },
        }),
      );
      expect(await readDesktopProofPhase(file)).toEqual({
        status: "available",
        lastObservedPhase: "gateway-start",
        owners: { gateway, endpointTap: "owned" },
      });
    }
    for (const owners of [
      null,
      { gateway: "closed" },
      { gateway: "private", endpointTap: "closed" },
    ]) {
      await writeFile(file, JSON.stringify({ lastObservedPhase: "gateway-start", owners }));
      expect((await readDesktopProofPhase(file)).owners).toBeNull();
    }
  });

  it("accepts only bounded regular reporter files", async () => {
    const root = dirs.make("desktop-private-report-");
    const file = path.join(root, "report.json");
    await writeFile(file, JSON.stringify(rawTestReport()));
    expect((await readDesktopProofTestReport(file)).failedTests).toBe(1);
    const link = path.join(root, "report-link.json");
    await symlink(file, link);
    await expect(readDesktopProofTestReport(link)).rejects.toThrow("regular file");
    await writeFile(file, "{");
    await expect(readDesktopProofTestReport(file)).rejects.toThrow();
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
    await expect(readDesktopProofTestReport(file)).rejects.toThrow("bounded");
  });

  it("launches only the owned foreground window manager, without session autostart", async () => {
    const bootstrap = await readFile(
      new URL("../../scripts/test-desktop-resize-real.mts", import.meta.url),
      "utf8",
    );
    expect(bootstrap).toContain('daemon(`wm-${display}`, "openbox", ["--sm-disable"], env)');
    expect(bootstrap).not.toMatch(
      /"(?:startxfce4|xfce4-session|openbox-session|dbus-run-session|--startup)"/u,
    );
  });

  it("retains child ownership when both private logging and export fail", async () => {
    const child = Object.assign(new Error("child cleanup failed"), {
      processTreeState: "live",
      code: "EPROCESSGROUP_CLEANUP_FAILED",
    });
    const logging = new Error("log write failed");
    const exporting = new Error("export failed");
    let unjoined = false;
    const record = (error: unknown) => {
      unjoined ||= hasUnjoinedWork(error);
    };
    const failure = await withDesktopProofCleanup(
      () =>
        withDesktopProofCleanup(
          async () => {
            throw child;
          },
          async () => {
            expect(unjoined).toBe(true);
            throw logging;
          },
          record,
        ),
      async () => {
        expect(unjoined).toBe(true);
        throw exporting;
      },
      record,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0].errors).toEqual([child, logging]);
    expect(aggregate.errors[1]).toBe(exporting);
    expect(hasUnjoinedWork(failure)).toBe(true);
    expect(unjoined).toBe(true);
  });

  it.each(["entries", "bytes"] as const)(
    "shares the %s budget across node and SSH",
    async (limit) => {
      const root = dirs.make("desktop-shared-budget-");
      const input = path.join(root, "input");
      await mkdir(input);
      const data = JSON.stringify(assets);
      await writeFile(path.join(input, "served-assets.json"), data);
      const budget = {
        entries: limit === "entries" ? 255 : 0,
        bytes: limit === "bytes" ? 64 * 1024 ** 2 - Buffer.byteLength(data) : 0,
      };
      await exportDesktopResizeProof(input, path.join(root, "node"), "node", budget);
      await expect(
        exportDesktopResizeProof(input, path.join(root, "ssh"), "ssh", budget),
      ).rejects.toThrow(/bound/u);
    },
  );
  it("distinguishes literal head proof from GitHub merge-tree proof", () => {
    expect(
      desktopProofSource({ head, tree, parents: [base] }, { checkout: head, head, base }).kind,
    ).toBe("pr-head");
    expect(
      desktopProofSource(
        { head: merge, tree, parents: [base, head] },
        { checkout: merge, head, base },
      ),
    ).toMatchObject({
      kind: "pr-merge",
      prHead: head,
      prEventBase: base,
      testedBase: base,
      head: merge,
    });
    expect(desktopProofSource({ head, tree, parents: [base] }, { checkout: head }).kind).toBe(
      "checkout",
    );
  });

  it("reads actual merge parents at a depth-one Git boundary without conflating the event base", async () => {
    const root = dirs.make("desktop-shallow-source-");
    const git = (args: string[], input?: string) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: root,
        input,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test Author",
          GIT_AUTHOR_EMAIL: "author@example.invalid",
          GIT_COMMITTER_NAME: "Test Committer",
          GIT_COMMITTER_EMAIL: "committer@example.invalid",
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
        },
      }).trim();
    git(["init", "--quiet"]);
    const objectTree = git(["mktree"], "");
    const eventBase = git(["commit-tree", objectTree, "-m", "event base"]);
    const testedBase = git(["commit-tree", objectTree, "-p", eventBase, "-m", "tested base"]);
    const prHead = git(["commit-tree", objectTree, "-p", eventBase, "-m", "PR head"]);
    const checkout = git([
      "commit-tree",
      objectTree,
      "-p",
      testedBase,
      "-p",
      prHead,
      "-m",
      "test merge",
    ]);
    git(["update-ref", "HEAD", checkout]);
    await writeFile(path.join(root, ".git", "shallow"), `${checkout}\n`);
    expect(git(["rev-parse", "--is-shallow-repository"])).toBe("true");
    expect(git(["show", "-s", "--format=%P", "HEAD"])).toBe("");
    const observedHead = git(["rev-parse", "--verify", "HEAD"]);
    const actual = desktopProofCommit(observedHead, git(["cat-file", "commit", observedHead]));
    expect(desktopProofSource(actual, { checkout, head: prHead, base: eventBase })).toEqual({
      head: checkout,
      tree: objectTree,
      parents: [testedBase, prHead],
      kind: "pr-merge",
      prHead,
      prEventBase: eventBase,
      testedBase,
    });
  });

  it("reads only raw commit headers, not signature continuations or the message", () => {
    expect(
      desktopProofCommit(
        merge,
        `tree ${tree}\nparent ${base}\nparent ${head}\ngpgsig signature\n parent ${merge}\n\nparent ${merge}\n`,
      ),
    ).toEqual({ head: merge, tree, parents: [base, head] });
  });

  it.each([[], [base], [base, merge], [base, head, merge]].map((parents) => ({ parents })))(
    "rejects unbound actual merge parents: $parents",
    ({ parents }) => {
      expect(() =>
        desktopProofSource({ head: merge, tree, parents }, { checkout: merge, head, base }),
      ).toThrow();
    },
  );

  it.each([
    { checkout: base, head, base },
    { checkout: merge, head: base, base: head },
    { checkout: merge, head },
  ])("rejects source drift and unbound PR parents: %j", (expected) => {
    expect(() =>
      desktopProofSource({ head: merge, tree, parents: [base, head] }, expected),
    ).toThrow();
  });

  it.each(["node", "ssh"] as const)("exports only named %s facts", (carrier) => {
    const safe = sanitizeDesktopResizeProof(proof(carrier), carrier);
    expect(JSON.stringify(safe)).not.toMatch(/private|hello|token|deviceId/u);
    expect(safe.carrier).toBe(carrier);
    expect(safe.samples).toHaveLength(5);
  });

  it.each([
    { node: null },
    { node: { passwordAbsentFromObserve: true, disconnectClosedViewer: false } },
    { observer: { keyboardForwardedBytes: 1, resizeForwardedBytes: 0 } },
    { gateway: { execution: "built-process", readiness: "readyz", minimal: true } },
    { observer: { evidence: "filter-spy", keyboardForwardedBytes: 0, resizeForwardedBytes: 0 } },
    { samples: [] },
    { pixels: { distinctSampledColors: 8 } },
  ])("rejects incomplete or failed node proof: %j", (invalid) => {
    expect(() => sanitizeDesktopResizeProof({ ...proof(), ...invalid }, "node")).toThrow();
  });

  it("rejects asset paths and non-digests", () => {
    expect(() => desktopProofAssets({ "../index.js": "e".repeat(64) })).toThrow();
    expect(() => desktopProofAssets({ "index.js": "private" })).toThrow();
  });

  it("exports a complete bounded allowlist without raw diagnostics or metadata", async () => {
    const root = dirs.make("desktop-public-proof-");
    const input = path.join(root, "input");
    const output = path.join(root, "public");
    const nested = path.join(input, "desktop-suite");
    await mkdir(nested, { recursive: true });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path.join(nested, "01-fit.png"), png);
    for (const stage of desktopResizeStages) {
      await writeFile(path.join(nested, `${stage}.png`), png);
      await writeFile(
        path.join(nested, `${stage}-geometry.json`),
        JSON.stringify({
          stage,
          expected: size,
          guest: size,
          canvas: size,
          matchOffered: true,
          hello: { token: "private" },
        }),
      );
    }
    await writeFile(path.join(nested, "served-assets.json"), JSON.stringify(assets));
    await writeFile(path.join(nested, "resize-proof.json"), JSON.stringify(proof()));
    await writeFile(path.join(nested, "connection-diagnostics.json"), "private-token");
    expect((await exportDesktopResizeProof(input, output, "node")).complete).toBe(true);
    expect(await readdir(output)).toHaveLength(13);
    expect(await readFile(path.join(output, "resize-proof.json"), "utf8")).not.toMatch(
      /private|hello|deviceId/u,
    );
    expect(await readFile(path.join(output, "02-panel-geometry.json"), "utf8")).not.toContain(
      "hello",
    );
  });

  it("does not turn a skipped test into completed proof", async () => {
    const root = dirs.make("desktop-empty-proof-");
    const input = path.join(root, "input");
    await mkdir(input);
    expect((await exportDesktopResizeProof(input, path.join(root, "public"), "ssh")).complete).toBe(
      false,
    );
  });

  it("rejects symlinks instead of publishing their targets", async () => {
    const root = dirs.make("desktop-symlink-proof-");
    const input = path.join(root, "input");
    await mkdir(input);
    await writeFile(path.join(root, "secret"), "private-token");
    await symlink(path.join(root, "secret"), path.join(input, "resize-proof.json"));
    await expect(
      exportDesktopResizeProof(input, path.join(root, "public"), "node"),
    ).rejects.toThrow("regular-file");
  });
});
