import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  captureClaimNamespace,
  verifyNoStagingClaims,
} from "../../scripts/crabbox-staging-claims.mts";
import { hasUnjoinedWork, runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: command,
}));

const temporary: string[] = [];
afterEach(() => {
  command.mockReset();
  cleanupTempDirs(temporary);
});

function fixture(state = "state") {
  const root = makeTempDir(temporary, "openclaw-staging-claims-");
  const source = join(root, "source");
  mkdirSync(source);
  const env = { XDG_STATE_HOME: resolve(root, state), HOME: root };
  const namespace = captureClaimNamespace(source, env);
  return { root, source, env, namespace, binary: "fixture-crabbox", cwd: root, sourceRoot: source };
}

function output(claims: { leaseId: string; repoRoot: string }[] = [], problems: unknown[] = []) {
  return JSON.stringify({ version: 1, source: "local-claims", claims, problems }) + "\n";
}

function nativeResponse(
  stdout: string | Buffer,
  options: {
    status?: number;
    stderr?: Buffer;
    error?: unknown;
    mutate?: () => void;
  } = {},
) {
  command.mockImplementationOnce(async (invocation: Parameters<typeof runManagedCommand>[0]) => {
    const child = { stdout: new PassThrough(), stderr: new PassThrough() };
    invocation.onReady?.(child as unknown as ChildProcess);
    child.stdout.emit("data", typeof stdout === "string" ? Buffer.from(stdout) : stdout);
    if (options.stderr) {
      child.stderr.emit("data", options.stderr);
    }
    child.stdout.destroy();
    child.stderr.destroy();
    options.mutate?.();
    if (options.error) {
      throw options.error instanceof Error
        ? options.error
        : new Error("Native claims fixture failed", { cause: options.error });
    }
    return options.status ?? 0;
  });
}

it("queries an initially absent namespace without creating state and pins relative location to the original cwd", async () => {
  const context = fixture();
  const env = { ...context.env, XDG_STATE_HOME: "relative state " };
  const namespace = captureClaimNamespace(context.source, env);
  expect(namespace.directory).toBe(join(context.source, "relative state ", "crabbox", "claims"));
  nativeResponse(output());
  await expect(verifyNoStagingClaims({ ...context, env, namespace })).resolves.toEqual({
    ok: true,
  });
  expect(existsSync(namespace.directory)).toBe(false);
  expect(command).toHaveBeenCalledWith(
    expect.objectContaining({
      bin: context.binary,
      args: ["claims", "list", "--json"],
      cwd: context.root,
      env: expect.objectContaining({ XDG_STATE_HOME: join(context.source, "relative state ") }),
      timeoutMs: 5_000,
      requireProcessTreeExit: process.platform !== "win32",
    }),
  );
});

it("uses the native platform config-directory fallback when XDG_STATE_HOME is empty", () => {
  const context = fixture();
  const env = {
    HOME: context.root,
    XDG_STATE_HOME: "",
    XDG_CONFIG_HOME: join(context.root, "config"),
    AppData: join(context.root, "appdata"),
  };
  const expected =
    process.platform === "darwin"
      ? join(context.root, "Library", "Application Support", "crabbox", "state", "claims")
      : process.platform === "win32"
        ? join(context.root, "appdata", "crabbox", "state", "claims")
        : join(context.root, "config", "crabbox", "state", "claims");
  expect(captureClaimNamespace(context.source, env).directory).toBe(expected);
});

it("accepts a store created below its recorded absent-store anchor", async () => {
  const context = fixture();
  mkdirSync(context.namespace.directory, { recursive: true });
  nativeResponse(output());
  await expect(verifyNoStagingClaims(context)).resolves.toEqual({ ok: true });
});

it("holds a changed namespace before invoking the native CLI", async () => {
  const context = fixture();
  const result = await verifyNoStagingClaims({
    ...context,
    env: { ...context.env, XDG_STATE_HOME: join(context.root, "other") },
  });
  expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("location changed") });
  expect(command).not.toHaveBeenCalled();
});

it("holds replacement of an existing namespace identity", async () => {
  const context = fixture();
  mkdirSync(context.namespace.directory, { recursive: true });
  const namespace = captureClaimNamespace(context.source, context.env);
  renameSync(namespace.directory, namespace.directory + "-original");
  mkdirSync(namespace.directory);
  expect(await verifyNoStagingClaims({ ...context, namespace })).toMatchObject({ ok: false });
  expect(command).not.toHaveBeenCalled();
});

it("holds a namespace that appears during an empty native inventory", async () => {
  const context = fixture();
  nativeResponse(output(), {
    mutate: () => mkdirSync(context.namespace.directory, { recursive: true }),
  });
  expect(await verifyNoStagingClaims(context)).toMatchObject({
    ok: false,
    reason: expect.stringContaining("changed during"),
  });
});

it("returns only bounded matching lease IDs for source descendants and canonical aliases", async () => {
  const context = fixture();
  const alias = join(context.root, "source-alias");
  symlinkSync(context.source, alias, process.platform === "win32" ? "junction" : "dir");
  nativeResponse(
    output([
      { leaseId: "cbx_stage", repoRoot: join(context.source, "missing-child") },
      { leaseId: "cbx_alias", repoRoot: alias },
      { leaseId: "cbx_neighbor", repoRoot: context.source + "-neighbor" },
    ]),
  );
  expect(await verifyNoStagingClaims(context)).toMatchObject({
    ok: false,
    matchingLeaseIds: ["cbx_stage", "cbx_alias"],
  });
  nativeResponse(output([{ leaseId: "cbx_neighbor", repoRoot: context.source + "-neighbor" }]));
  expect(await verifyNoStagingClaims(context)).toEqual({ ok: true });
  nativeResponse(
    output(
      Array.from({ length: 20 }, (_, index) => ({
        leaseId: `cbx_${index}`,
        repoRoot: context.source,
      })),
    ),
  );
  const bounded = await verifyNoStagingClaims(context);
  expect(bounded.ok).toBe(false);
  if (!bounded.ok) {
    expect(bounded.matchingLeaseIds).toHaveLength(16);
  }
});

it.each([
  ["nonzero partial inventory", output(), 2],
  [
    "reported local problem",
    output([], [{ file: "claim.json", code: "read_error", message: "unreadable" }]),
    0,
  ],
  [
    "unsupported version",
    JSON.stringify({ version: 2, source: "local-claims", claims: [], problems: [] }),
    0,
  ],
  ["malformed JSON", '{"private-fixture-value":', 0],
  ["nonabsolute claim root", output([{ leaseId: "cbx_unknown", repoRoot: "relative" }]), 0],
  ["invalid encoding", Buffer.from([0xff]), 0],
] as const)("holds %s without exposing claim output", async (_name, stdout, status) => {
  const context = fixture();
  nativeResponse(stdout, { status });
  const result = await verifyNoStagingClaims(context);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).not.toContain("private-fixture-value");
    expect(result.reason).not.toContain(context.source);
  }
});

it("preserves unjoined cleanup evidence when bounded capture aborts the native child", async () => {
  const context = fixture();
  const cleanup = new AggregateError(
    [Object.assign(new Error("fixture could not settle"), { processTreeState: "indeterminate" })],
    "fixture cleanup failed",
  );
  nativeResponse(Buffer.alloc(4 * 1024 * 1024 + 1), { error: cleanup });
  const result = await verifyNoStagingClaims(context);
  expect(result).toMatchObject({ ok: false, unjoined: true });
  expect(hasUnjoinedWork(result)).toBe(true);
  expect(command.mock.calls[0]?.[0].signal.aborted).toBe(true);
  if (!result.ok) {
    expect(result.error).toMatchObject({ cause: cleanup });
  }
});

it("bounds discarded stderr as well as captured JSON", async () => {
  const context = fixture();
  nativeResponse(output(), { stderr: Buffer.alloc(64 * 1024 + 1) });
  expect(await verifyNoStagingClaims(context)).toMatchObject({
    ok: false,
    reason: expect.stringContaining("output limit"),
  });
});

it("does not query inventory after caller cancellation", async () => {
  const context = fixture();
  const cancellation = new Error("fixture cancellation");
  const controller = new AbortController();
  controller.abort(cancellation);
  expect(await verifyNoStagingClaims({ ...context, signal: controller.signal })).toMatchObject({
    ok: false,
    error: cancellation,
  });
  expect(command).not.toHaveBeenCalled();
});

it("forwards caller cancellation and cannot return success after native completion races it", async () => {
  const context = fixture();
  const cancellation = new Error("fixture cancellation");
  const controller = new AbortController();
  nativeResponse(output(), { mutate: () => controller.abort(cancellation) });
  expect(await verifyNoStagingClaims({ ...context, signal: controller.signal })).toMatchObject({
    ok: false,
    error: cancellation,
  });
  expect(command.mock.calls[0]?.[0].signal.aborted).toBe(true);
});
