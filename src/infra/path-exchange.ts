import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "./errors.js";

export type PathExchangeResult =
  | { status: "exchanged"; route: string }
  | { status: "unavailable"; reason: string };

/** Generous for a cold interpreter start on old hardware; the call itself is one system call. */
const EXCHANGE_TOOL_TIMEOUT_MS = 30_000;

// Node has no binding for `renameat2(RENAME_EXCHANGE)` (Linux) or
// `renamex_np(RENAME_SWAP)` (macOS), so a short-lived tool makes the one call.
// 2 is the exchange flag of both calls; -100 is Linux's AT_FDCWD.
const NODE_FFI_SCRIPT = `
const [first, second] = process.argv.slice(1);
try {
  const { dlopen } = require("node:ffi");
  if (process.platform === "darwin") {
    const signature = { arguments: ["string", "string", "uint32"], result: "int32" };
    dlopen(null, { renamex_np: signature }).functions.renamex_np(first, second, 2);
  } else {
    const signature = { arguments: ["int32", "string", "int32", "string", "uint32"], result: "int32" };
    dlopen(null, { renameat2: signature }).functions.renameat2(-100, first, -100, second, 2);
  }
} catch (error) {
  console.error(String(error && error.message));
  process.exitCode = 1;
}`;
const OSASCRIPT_SCRIPT = `
function run(argv) {
  ObjC.bindFunction("renamex_np", ["int", ["char *", "char *", "unsigned int"]]);
  if ($.renamex_np(argv[0], argv[1], 2) !== 0) {
    throw new Error("renamex_np refused the exchange");
  }
}`;
// The system call number is per architecture; perl's own build names the one it runs as.
const PERL_SCRIPT = `
use Config;
my %number = (x86_64 => 316, aarch64 => 276);
my ($machine) = $Config{archname} =~ /^(\\w+)-linux/;
my $renameat2 = $number{$machine // ""} or die "no renameat2 number for $Config{archname}\\n";
syscall($renameat2, -100, $ARGV[0], -100, $ARGV[1], 2) == 0 or die "renameat2: $!\\n";`;

type ExchangeRoute = { name: string; file: string; args: string[] };

/** Whether this platform has an exchange call; `exchangePaths` can still report `unavailable`. */
export const supportsPathExchange = () =>
  process.platform === "darwin" || process.platform === "linux";

function exchangeRoutes(first: string, second: string): ExchangeRoute[] {
  if (!supportsPathExchange()) {
    return [];
  }
  const routes: ExchangeRoute[] = [];
  // Known without loading the module, whose experimental warning belongs in no update output.
  if (!process.versions.bun && process.allowedNodeEnvironmentFlags.has("--experimental-ffi")) {
    routes.push({
      name: "node:ffi",
      file: process.execPath,
      args: ["--experimental-ffi", "--no-warnings", "-e", NODE_FFI_SCRIPT, first, second],
    });
  }
  routes.push(
    process.platform === "darwin"
      ? {
          name: "osascript",
          file: "/usr/bin/osascript",
          args: ["-l", "JavaScript", "-e", OSASCRIPT_SCRIPT, first, second],
        }
      : { name: "perl", file: "/usr/bin/perl", args: ["-e", PERL_SCRIPT, first, second] },
  );
  return routes;
}

/** Resolves with why the tool failed, or undefined when it ran and exited cleanly. */
function runExchangeTool(route: ExchangeRoute): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        route.file,
        route.args,
        // An empty environment: no NODE_OPTIONS or PERL5OPT preload can stall or change the tool.
        { timeout: EXCHANGE_TOOL_TIMEOUT_MS, killSignal: "SIGKILL", env: {} },
        (error, _stdout, stderr) => {
          const said = stderr.trim().split("\n").at(-1)?.slice(0, 200);
          const code = typeof error?.code === "number" ? `exit ${error.code}` : error?.code;
          resolve(error ? said || code || error.signal || "failed" : undefined);
        },
      );
    } catch (error) {
      resolve(formatErrorMessage(error));
    }
  });
}

const identityOf = async (target: string) => {
  const stat = await fs.lstat(target, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

/**
 * Atomically exchange two existing paths on one filesystem: no instant has either
 * path missing. A tool's exit code is not trusted; the paths' identities decide.
 * `unavailable` means nothing changed, and is how a platform, a missing tool, or
 * a filesystem without the operation reports. Throws only when the paths ended
 * in neither state, which another writer caused.
 */
export async function exchangePaths(
  first: string,
  second: string,
  assertCurrent: () => void,
): Promise<PathExchangeResult> {
  let before: readonly [string, string];
  try {
    before = [await identityOf(first), await identityOf(second)];
  } catch (error) {
    return { status: "unavailable", reason: formatErrorMessage(error) };
  }
  if (before[0] === before[1]) {
    return { status: "unavailable", reason: `${first} and ${second} are the same file` };
  }
  const failures: string[] = [];
  for (const route of exchangeRoutes(path.resolve(first), path.resolve(second))) {
    // Filesystem inspection may outlive the caller's mutation authority.
    assertCurrent();
    const failure = await runExchangeTool(route);
    const [nowFirst, nowSecond] = await Promise.all(
      [first, second].map((target) => identityOf(target).catch(() => null)),
    );
    if (nowFirst === before[1] && nowSecond === before[0]) {
      return { status: "exchanged", route: route.name };
    }
    if (nowFirst !== before[0] || nowSecond !== before[1]) {
      throw new Error(
        `${first} and ${second} changed during an exchange through ${route.name}; another writer changed them.`,
      );
    }
    failures.push(`${route.name}: ${failure ?? "changed nothing"}`);
  }
  return {
    status: "unavailable",
    reason: failures.join("; ") || `no exchange route on ${process.platform}`,
  };
}
