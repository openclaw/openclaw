import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const state = vi.hoisted(() => ({
  launchctl: { stdout: "", stderr: "Could not find service", code: 113 },
  files: new Map<string, { label?: unknown; error?: string }>(),
  capturedPlists: new Map<Uint8Array, { Label?: unknown }>(),
}));

function fsError(code: string, target: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${target}`), { code });
}

vi.mock("node:fs/promises", () => {
  const mocked = {
    readdir: vi.fn(async (dir: string) =>
      [...state.files.keys()]
        .filter((file) => path.dirname(file) === dir)
        .map((file) => path.basename(file)),
    ),
    readFile: vi.fn(async (target: string) => {
      const file = state.files.get(target);
      if (!file || file.error) {
        throw fsError(file?.error ?? "ENOENT", target);
      }
      const bytes = Buffer.from("<plist/>");
      state.capturedPlists.set(bytes, { Label: file.label });
      return bytes;
    }),
  };
  return { ...mocked, default: mocked };
});

const execLaunchctl = vi.hoisted(() =>
  vi.fn(async () => ({ ...state.launchctl, termination: "exit" as const })),
);

vi.mock("./launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./launchd-exec.js")>()),
  execLaunchctl,
}));

const runExec = vi.hoisted(() =>
  vi.fn(async (_command: string, args: string[], options: { input: string | Uint8Array }) => {
    if (typeof options.input === "string" && args[1] === "json") {
      return { stdout: options.input, stderr: "" };
    }
    if (typeof options.input === "string") {
      throw new Error("Native parser requires captured bytes before normalization");
    }
    const captured = state.capturedPlists.get(options.input);
    if (!captured) {
      throw new Error("Native parser requires the captured definition bytes");
    }
    return { stdout: JSON.stringify(captured), stderr: "" };
  }),
);

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec,
}));

import {
  assertNoSystemLaunchDaemonOwnership,
  inspectSystemLaunchDaemonOwnership,
  renderSystemLaunchDaemonOwnershipShellProbe,
} from "./launchd-system.js";

const label = "ai.openclaw.gateway";
const serviceTarget = `system/${label}`;
const absent = { status: "absent", serviceTarget };
const inspect = (options?: Parameters<typeof inspectSystemLaunchDaemonOwnership>[1]) =>
  inspectSystemLaunchDaemonOwnership(label, options);
function plist(name: string, value?: unknown, error?: string) {
  const target = `/Library/LaunchDaemons/${name}.plist`;
  state.files.set(target, { label: value, error });
  return target;
}
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const hostPlatform = process.platform;
const absentQuery = 'printf "%s\\n" "Could not find service" >&2\nexit 113';

function executeProbe(
  root: string,
  parser: string,
  env: NodeJS.ProcessEnv,
  options: { missingReader?: boolean; timeout?: number } = {},
) {
  let script = renderSystemLaunchDaemonOwnershipShellProbe(label)
    .replaceAll("/Library/LaunchDaemons", path.join(root, "daemons"))
    .replaceAll("/usr/bin/plutil", parser);
  if (options.missingReader) {
    script = script.replaceAll("/usr/bin/perl", path.join(root, "missing-perl"));
  }
  script +=
    '\nprintf "conflict=%s\\ndetail=%s\\n" "$openclaw_system_launchd_conflict" "$openclaw_system_launchd_detail"\n';
  const output = execFileSync(hostPlatform === "darwin" ? "/bin/sh" : "/bin/bash", ["-c", script], {
    encoding: "utf8",
    timeout: options.timeout,
    env: { HOME: root, TMPDIR: root, PATH: root, ...env },
  });
  return {
    conflict: output.match(/^conflict=(.*)$/m)?.[1],
    detail: output.match(/^detail=(.*)$/m)?.[1],
  };
}

function runRenderedProbe(
  plistName: string,
  plistMode: "unlabeled" | "same-label" | "malformed" | "unreadable",
  launchctlBody = absentQuery,
) {
  const root = tempDirs.make("openclaw-launchd-probe-");
  const daemonsDir = path.join(root, "daemons");
  const binDir = path.join(root, "bin");
  const probeLog = path.join(root, "probe.log");
  mkdirSync(daemonsDir);
  mkdirSync(binDir);
  writeFileSync(probeLog, "");
  writeFileSync(path.join(root, "non-executable"), "#!/bin/sh\nexit 0\n", { mode: 0o600 });
  writeFileSync(path.join(daemonsDir, plistName), `${plistMode}\n`);
  const shim = (name: string, event: string, body: string) => {
    const target = path.join(binDir, name);
    const log = `printf '${event}\\n' >> "$OPENCLAW_TEST_PROBE_LOG"`;
    writeFileSync(target, `#!/bin/sh\n${log}\n${body}\n`, { mode: 0o700 });
    chmodSync(target, 0o700);
    return target;
  };
  const plutilShim = shim(
    "plutil",
    "scan",
    `
mode=$1
for last; do :; done
case "$last" in
  *unreadable*) printf '%s\\n' "Operation not permitted" >&2; exit 1 ;;
esac
fixture=$(/bin/cat "$last")
case "$mode:$fixture" in
  -extract:same-label) printf '%s' "ai.openclaw.gateway"; exit 0 ;;
  -extract:*) printf '%s\\n' "No value at that key path: Label" >&2 ;;
  -lint:malformed) ;;
  -lint:*) exit 0 ;;
esac
exit 1
`,
  );
  shim("launchctl", "query", launchctlBody);
  if (plistMode === "unreadable") {
    chmodSync(path.join(daemonsDir, plistName), 0o000);
  }
  return {
    ...executeProbe(root, plutilShim, {
      PATH: binDir,
      OPENCLAW_TEST_PROBE_LOG: probeLog,
      OPENCLAW_TEST_PROBE_DIR: root,
    }),
    events: readFileSync(probeLog, "utf8").trim().split("\n").filter(Boolean),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.launchctl = { stdout: "", stderr: "Could not find service", code: 113 };
  state.files.clear();
  state.capturedPlists.clear();
  Object.defineProperty(process, "platform", { value: "darwin" });
});

afterEach(() => Object.defineProperty(process, "platform", { value: hostPlatform }));

it("fails closed when launchctl cannot classify system ownership", async () => {
  state.launchctl = { stdout: "", stderr: "Operation not permitted", code: 1 };

  await expect(inspect()).resolves.toEqual({
    status: "unverifiable",
    serviceTarget,
    operation: "launchctl",
    detail: "Operation not permitted",
    reason: "launchd-system-domain-unavailable",
  });
});

it.each([
  ["valid non-string Label", 42, undefined, true],
  ["read-only status probe", undefined, undefined, false],
] as const)("reports no ownership for a %s", async (_name, value, error, scanInstalledPlists) => {
  plist("com.vendor.foreign", value, error);
  await expect(inspect({ scanInstalledPlists })).resolves.toEqual(absent);
  expect(execLaunchctl).toHaveBeenCalledTimes(1);
  await expect(assertNoSystemLaunchDaemonOwnership(label)).resolves.toBeUndefined();
});

it("refuses an unreadable native result for a readable plist", async () => {
  const plistPath = plist("com.vendor.worker");
  runExec.mockRejectedValueOnce(fsError("ENOENT", "/usr/bin/plutil"));
  await expect(inspect()).resolves.toMatchObject({
    status: "unverifiable",
    operation: "filesystem",
    detail: expect.stringContaining(plistPath),
  });
});

it("detects a readable owner after an unreadable foreign plist", async () => {
  plist("com.vendor.locked", undefined, "EACCES");
  const owner = plist("vendor-openclaw", label);
  await expect(inspect()).resolves.toEqual({
    status: "installed",
    serviceTarget,
    plistPath: owner,
  });
});

it("throws one typed recovery error and documents that force cannot bypass it", async () => {
  state.launchctl = { stdout: "state = running", stderr: "", code: 0 };

  const error = await assertNoSystemLaunchDaemonOwnership(label).catch((caught: unknown) => caught);

  expect(error).toMatchObject({
    name: "SystemLaunchDaemonOwnershipError",
    code: "SYSTEM_LAUNCH_DAEMON_OWNERSHIP",
    ownership: { status: "loaded", serviceTarget },
  });
  expect(String(error)).toContain("duplicate KeepAlive managers can restart-loop the gateway");
  expect(String(error)).toContain("--force does not override system ownership");
  expect(String(error)).toContain("sudo launchctl bootout system/ai.openclaw.gateway");
});

it("executes the rendered probe across readable and unreadable plists", () => {
  expect(runRenderedProbe("com.google.keystone.daemon.plist", "unlabeled").conflict).toBe("");
  expect(runRenderedProbe("com.vendor.unreadable.plist", "unreadable").conflict).toBe("");
  expect(runRenderedProbe("vendor-openclaw.plist", "same-label").conflict).toContain(
    "vendor-openclaw.plist",
  );
  expect(runRenderedProbe("com.vendor.broken.plist", "malformed").conflict).toContain(
    "com.vendor.broken.plist",
  );
});

const afterAbsent = (command: string) => `printf 'Could not find service\\n' >&2\n${command}`;
it.each([
  ["loaded", "exit 0", "loaded system LaunchDaemon"],
  ["absent", absentQuery, ""],
  ["query error", 'printf "Operation not permitted\\n" >&2\nexit 1', "could not verify"],
  ["signal", afterAbsent("kill -TERM $$"), "could not verify"],
  [
    "execution failure",
    afterAbsent('exec "$OPENCLAW_TEST_PROBE_DIR/non-executable"'),
    "could not verify",
  ],
  ["missing command", afterAbsent('exec "$OPENCLAW_TEST_PROBE_DIR/missing"'), "could not verify"],
] as const)("executes the rendered ownership query with %s outcome", (scenario, body, detail) => {
  const result = runRenderedProbe("foreign.plist", "unlabeled", body);
  expect(result.conflict).toBe(detail ? "system/ai.openclaw.gateway" : "");
  if (detail) {
    expect(result.detail).toContain(detail);
  } else {
    expect(result.detail).toBe("");
  }
  expect(result.events).toEqual(scenario === "absent" ? ["query", "scan", "scan"] : ["query"]);
});

const xmlPlist = (body: string) => `<plist version="1.0"><dict>${body}</dict></plist>`;
const xmlLabel = "<key>Label</key><string>ai.openclaw.gateway</string>";
const owner = expect.stringContaining("unrelated-name.plist");
const writeShell = (file: string, source: string) => writeFileSync(file, source, { mode: 0o700 });

type ProbeOptions = Partial<
  Record<
    "binary" | "parserDenied" | "deniedRead" | "directory" | "missingReader" | "loadedAfterScan",
    boolean
  >
> & { perlUnicode?: string; extractionFailure?: 2 | 126 | 127 | "signal" };

function runFallback(contents: string, options: ProbeOptions = {}) {
  const root = tempDirs.make("openclaw-system-shell-");
  const target = path.join(root, "daemons", "unrelated-name.plist");
  mkdirSync(path.dirname(target));
  if (options.directory) {
    mkdirSync(target);
  } else {
    writeFileSync(target, contents);
    if (options.binary) {
      execFileSync("/usr/bin/plutil", ["-convert", "binary1", "--", target]);
    }
  }
  const parser = path.join(root, "plutil");
  writeShell(
    parser,
    `#!/bin/sh
for last; do :; done
if [ "$last" = '-' ] && [ "$1" = '-extract' ]; then
  ${options.extractionFailure === "signal" ? 'kill -TERM "$$"' : options.extractionFailure ? `exit ${options.extractionFailure}` : ":"}
fi
if [ "$last" = '-' ] || [ "${options.parserDenied === false ? "0" : "1"}" = "0" ]; then
  exec /usr/bin/plutil "$@"
fi
${options.deniedRead ? '/bin/chmod 000 "$last"' : ":"}
exit 1
`,
  );
  writeShell(
    path.join(root, "launchctl"),
    `#!/bin/sh
if [ -e "$TEST_QUERY_MARKER" ]; then
  ${options.loadedAfterScan ? "exit 0" : ":"}
fi
: >"$TEST_QUERY_MARKER"
printf 'Could not find service\\n' >&2
exit 113
`,
  );
  const { conflict, detail } = executeProbe(
    root,
    parser,
    {
      TEST_QUERY_MARKER: path.join(root, "queried"),
      PERL_UNICODE: options.perlUnicode,
    },
    { missingReader: options.missingReader, timeout: 10_000 },
  );
  expect(readdirSync(root).filter((entry) => entry.startsWith("openclaw-launchd-"))).toEqual([]);
  if (options.binary !== undefined) {
    expect(detail).toContain("installed same-label system LaunchDaemon plist");
  }
  return conflict;
}

describe.skipIf(hostPlatform !== "darwin")("detached launchd native fallback", () => {
  const nested = xmlPlist(`<key>Nested</key><dict>${xmlLabel}</dict>`);
  const integer = xmlPlist("<key>Label</key><integer>42</integer>");
  const newline = xmlPlist(xmlLabel.replace("gateway</", "gateway\n</"));
  it.each([
    ["XML owner", xmlPlist(xmlLabel), { binary: false }, owner],
    ["binary owner", xmlPlist(xmlLabel), { binary: true }, owner],
    ["nested label", nested, {}, ""],
    ["newly loaded owner", nested, { loadedAfterScan: true }, "system/ai.openclaw.gateway"],
    ["native label type", integer, { parserDenied: false }, ""],
    ["fallback label type", integer, { parserDenied: true }, ""],
    ["native label bytes", newline, { parserDenied: false }, ""],
    ["fallback label bytes", newline, { parserDenied: true }, ""],
    ["inherited Unicode", xmlPlist(xmlLabel), { binary: true, perlUnicode: "D" }, owner],
    ["extraction 2", xmlPlist(xmlLabel), { extractionFailure: 2 }, owner],
    ["extraction 126", xmlPlist(xmlLabel), { extractionFailure: 126 }, owner],
    ["extraction 127", xmlPlist(xmlLabel), { extractionFailure: 127 }, owner],
    ["extraction signal", xmlPlist(xmlLabel), { extractionFailure: "signal" }, owner],
    ["malformed", "not a plist", {}, owner],
    ["oversize", "x".repeat(1048577), {}, owner],
    ["nonregular", "", { directory: true }, owner],
    ["missing reader", xmlPlist(xmlLabel), { missingReader: true }, owner],
  ] as const)("handles %s", (_name, contents, options, expected) => {
    expect(runFallback(contents, options)).toEqual(expected);
  });
  it.skipIf(process.getuid?.() === 0).each([false, true])(
    "handles read denial after preflight (loaded=%s)",
    (loadedAfterScan) => {
      expect(runFallback(xmlPlist(xmlLabel), { deniedRead: true, loadedAfterScan })).toBe(
        loadedAfterScan ? "system/ai.openclaw.gateway" : "",
      );
    },
  );
});
