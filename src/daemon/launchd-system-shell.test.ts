import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { renderSystemLaunchDaemonOwnershipShellProbe } from "./launchd-system.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const plist = (body: string) => `<plist version="1.0"><dict>${body}</dict></plist>`;
const label = "<key>Label</key><string>ai.openclaw.gateway</string>";
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
  let script = renderSystemLaunchDaemonOwnershipShellProbe("ai.openclaw.gateway")
    .replaceAll("/Library/LaunchDaemons", path.dirname(target))
    .replaceAll("/usr/bin/plutil", parser);
  if (options.missingReader) {
    script = script.replaceAll("/usr/bin/perl", path.join(root, "missing-perl"));
  }
  script += `\nprintf '%s\\n%s' "$openclaw_system_launchd_conflict" "$openclaw_system_launchd_detail"`;
  const [conflict, detail] = execFileSync("/bin/sh", ["-c", script], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: root,
      TMPDIR: root,
      TEST_QUERY_MARKER: path.join(root, "queried"),
      PERL_UNICODE: options.perlUnicode,
    },
  }).split("\n");
  expect(readdirSync(root).filter((entry) => entry.startsWith("openclaw-launchd-"))).toEqual([]);
  if (options.binary !== undefined) {
    expect(detail).toContain("installed same-label system LaunchDaemon plist");
  }
  return conflict;
}

describe.skipIf(process.platform !== "darwin")("detached launchd native fallback", () => {
  const nested = plist(`<key>Nested</key><dict>${label}</dict>`);
  const integer = plist("<key>Label</key><integer>42</integer>");
  const newline = plist(label.replace("gateway</", "gateway\n</"));
  it.each([
    ["XML owner", plist(label), { binary: false }, owner],
    ["binary owner", plist(label), { binary: true }, owner],
    ["nested label", nested, {}, ""],
    ["newly loaded owner", nested, { loadedAfterScan: true }, "system/ai.openclaw.gateway"],
    ["native label type", integer, { parserDenied: false }, ""],
    ["fallback label type", integer, { parserDenied: true }, ""],
    ["native label bytes", newline, { parserDenied: false }, ""],
    ["fallback label bytes", newline, { parserDenied: true }, ""],
    ["inherited Unicode", plist(label), { binary: true, perlUnicode: "D" }, owner],
    ["extraction 2", plist(label), { extractionFailure: 2 }, owner],
    ["extraction 126", plist(label), { extractionFailure: 126 }, owner],
    ["extraction 127", plist(label), { extractionFailure: 127 }, owner],
    ["extraction signal", plist(label), { extractionFailure: "signal" }, owner],
    ["malformed", "not a plist", {}, owner],
    ["oversize", "x".repeat(1048577), {}, owner],
    ["nonregular", "", { directory: true }, owner],
    ["missing reader", plist(label), { missingReader: true }, owner],
  ] as const)("handles %s", (_name, contents, options, expected) => {
    expect(runFallback(contents, options)).toEqual(expected);
  });
  it.skipIf(process.getuid?.() === 0).each([false, true])(
    "handles read denial after preflight (loaded=%s)",
    (loadedAfterScan) => {
      expect(runFallback(plist(label), { deniedRead: true, loadedAfterScan })).toBe(
        loadedAfterScan ? "system/ai.openclaw.gateway" : "",
      );
    },
  );
});
