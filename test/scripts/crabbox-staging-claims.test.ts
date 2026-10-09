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

it("holds namespace location, identity, and inventory races", async () => {
  for (const change of ["location changed", "replaced", "changed during"] as const) {
    const context = fixture();
    if (change === "location changed") {
      context.env.XDG_STATE_HOME = join(context.root, "other");
    } else if (change === "replaced") {
      mkdirSync(context.namespace.directory, { recursive: true });
      context.namespace = captureClaimNamespace(context.source, context.env);
      renameSync(context.namespace.directory, context.namespace.directory + "-original");
      mkdirSync(context.namespace.directory);
    } else {
      nativeResponse(output(), {
        mutate: () => mkdirSync(context.namespace.directory, { recursive: true }),
      });
    }
    expect(await verifyNoStagingClaims(context), change).toMatchObject({
      ok: false,
      reason: expect.stringContaining(change),
    });
    if (change !== "changed during") {
      expect(command).not.toHaveBeenCalled();
    }
  }
});

it("returns bounded matching source claims and ignores unattached or neighboring claims", async () => {
  const context = fixture();
  const alias = join(context.root, "source-alias");
  symlinkSync(context.source, alias, process.platform === "win32" ? "junction" : "dir");
  const claim = (leaseId: string, repoRoot: string) => ({ leaseId, repoRoot });
  const neighbor = claim("cbx_neighbor", context.source + "-neighbor");
  const unattached = claim("cbx_unattached", "");
  const cases: [Parameters<typeof output>[0], string[]?][] = [
    [
      [
        claim("cbx_stage", join(context.source, "missing-child")),
        claim("cbx_alias", alias),
        neighbor,
      ],
      ["cbx_stage", "cbx_alias"],
    ],
    [[neighbor]],
    [
      Array.from({ length: 20 }, (_, index) => claim(`cbx_${index}`, context.source)),
      Array.from({ length: 16 }, (_, index) => `cbx_${index}`),
    ],
    [[unattached, neighbor]],
    [[unattached, claim("cbx_stage", context.source)], ["cbx_stage"]],
  ];
  for (const [claims, matchingLeaseIds] of cases) {
    nativeResponse(output(claims));
    const result = await verifyNoStagingClaims(context);
    if (matchingLeaseIds) {
      expect(result).toMatchObject({ ok: false, matchingLeaseIds });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.matchingLeaseIds).toHaveLength(matchingLeaseIds.length);
      }
    } else {
      expect(result).toEqual({ ok: true });
    }
  }
});

it("holds incomplete or invalid inventories without exposing claim output", async () => {
  const cases: [string, string | Buffer, number][] = [
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
  ];
  for (const [name, stdout, status] of cases) {
    const context = fixture();
    nativeResponse(stdout, { status });
    const result = await verifyNoStagingClaims(context);
    expect(result.ok, name).toBe(false);
    if (!result.ok) {
      expect(result.reason, name).not.toContain("private-fixture-value");
      expect(result.reason, name).not.toContain(context.source);
    }
  }
});

it("bounds both output streams and preserves unjoined cleanup evidence", async () => {
  const cleanup = new AggregateError(
    [Object.assign(new Error("fixture could not settle"), { processTreeState: "indeterminate" })],
    "fixture cleanup failed",
  );
  for (const stream of ["stdout", "stderr"] as const) {
    const context = fixture();
    nativeResponse(
      stream === "stdout" ? Buffer.alloc(4 * 1024 * 1024 + 1) : output(),
      stream === "stdout" ? { error: cleanup } : { stderr: Buffer.alloc(64 * 1024 + 1) },
    );
    const result = await verifyNoStagingClaims(context);
    expect(command.mock.calls.at(-1)?.[0].signal.aborted).toBe(true);
    if (stream === "stdout") {
      expect(result).toMatchObject({ ok: false, unjoined: true });
      expect(hasUnjoinedWork(result)).toBe(true);
      if (!result.ok) {
        expect(result.error).toMatchObject({ cause: cleanup });
      }
    } else {
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("output limit") });
    }
  }
});

it("honors caller cancellation before and during native inventory", async () => {
  for (const timing of ["before", "during"] as const) {
    const context = fixture();
    const cancellation = new Error("fixture cancellation");
    const controller = new AbortController();
    if (timing === "before") {
      controller.abort(cancellation);
    } else {
      nativeResponse(output(), { mutate: () => controller.abort(cancellation) });
    }
    expect(await verifyNoStagingClaims({ ...context, signal: controller.signal })).toMatchObject({
      ok: false,
      error: cancellation,
    });
    if (timing === "before") {
      expect(command).not.toHaveBeenCalled();
    } else {
      expect(command.mock.calls[0]?.[0].signal.aborted).toBe(true);
    }
  }
});
