import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { renderSystemLaunchDaemonOwnershipShellProbe } from "./launchd-system.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const plist = (body: string) => `<plist version="1.0"><dict>${body}</dict></plist>`;
const label = "<key>Label</key><string>ai.openclaw.gateway</string>";

function runFallback(
  contents: string,
  options: {
    binary?: boolean;
    parserDenied?: boolean;
    perlUnicode?: string;
    deniedRead?: boolean;
    directory?: boolean;
    missingReader?: boolean;
    loadedAfterScan?: boolean;
    extractionFailure?: 2 | 126 | 127 | "signal";
  } = {},
) {
  const root = tempDirs.make("openclaw-system-shell-");
  const daemons = path.join(root, "daemons");
  const bin = path.join(root, "bin");
  mkdirSync(daemons);
  mkdirSync(bin);
  const target = path.join(daemons, "unrelated-name.plist");
  if (options.directory) {
    mkdirSync(target);
  } else {
    writeFileSync(target, contents);
    if (options.binary) {
      execFileSync("/usr/bin/plutil", ["-convert", "binary1", "--", target]);
    }
  }
  const parser = path.join(bin, "plutil");
  writeFileSync(
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
printf 'parser blocked by endpoint policy\\n' >&2
exit 1
`,
    { mode: 0o700 },
  );
  writeFileSync(
    path.join(bin, "launchctl"),
    `#!/bin/sh
if [ -e "$TEST_QUERY_MARKER" ]; then
  ${options.loadedAfterScan ? "exit 0" : ":"}
fi
: >"$TEST_QUERY_MARKER"
printf 'Could not find service\\n' >&2
exit 113
`,
    { mode: 0o700 },
  );
  let script = renderSystemLaunchDaemonOwnershipShellProbe("ai.openclaw.gateway")
    .replaceAll("/Library/LaunchDaemons", daemons)
    .replaceAll("/usr/bin/plutil", parser);
  if (options.missingReader) {
    script = script.replaceAll("/usr/bin/perl", path.join(bin, "missing-perl"));
  }
  const result = execFileSync(
    "/bin/sh",
    [
      "-c",
      `${script}\nprintf '%s\\n%s' "$openclaw_system_launchd_conflict" "$openclaw_system_launchd_detail"`,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: bin,
        TMPDIR: root,
        TEST_QUERY_MARKER: path.join(root, "queried"),
        PERL_UNICODE: options.perlUnicode,
      },
    },
  );
  expect(readdirSync(root).filter((entry) => entry.startsWith("openclaw-launchd-"))).toEqual([]);
  const [conflict, detail] = result.split("\n");
  if (options.binary !== undefined) {
    expect(detail).toContain("installed same-label system LaunchDaemon plist");
  }
  return conflict;
}

describe.skipIf(process.platform !== "darwin")("detached launchd native fallback", () => {
  it.each([false, true])("detects a parser-blocked owner (binary=%s)", (binary) => {
    expect(runFallback(plist(label), { binary })).toContain("unrelated-name.plist");
  });

  it("ignores nested labels but rechecks for a newly loaded owner", () => {
    const contents = plist(`<key>Nested</key><dict>${label}</dict>`);
    expect(runFallback(contents)).toBe("");
    expect(runFallback(contents, { loadedAfterScan: true })).toBe("system/ai.openclaw.gateway");
  });

  it.each([false, true])("preserves label type and bytes (parser denied=%s)", (parserDenied) => {
    expect(runFallback(plist("<key>Label</key><integer>42</integer>"), { parserDenied })).toBe("");
    expect(runFallback(plist(label.replace("gateway</", "gateway\n</")), { parserDenied })).toBe(
      "",
    );
  });

  it("reads binary snapshots despite inherited Perl Unicode settings", () => {
    expect(runFallback(plist(label), { binary: true, perlUnicode: "D" })).toContain(
      "unrelated-name.plist",
    );
  });

  it.each([2, 126, 127, "signal"] as const)(
    "refuses incomplete snapshot extraction (%s) even when lint would pass",
    (extractionFailure) => {
      expect(runFallback(plist(label), { extractionFailure })).toContain("unrelated-name.plist");
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "classifies actual read denial after readable preflight",
    () => {
      expect(runFallback(plist(label), { deniedRead: true })).toBe("");
      expect(runFallback(plist(label), { deniedRead: true, loadedAfterScan: true })).toBe(
        "system/ai.openclaw.gateway",
      );
    },
  );

  it.each([
    ["malformed", "not a plist", {}],
    ["oversize", "x".repeat(1048577), {}],
    ["nonregular", "", { directory: true }],
    ["missing reader", plist(label), { missingReader: true }],
  ] as const)("refuses %s fallback input", (_name, contents, options) => {
    expect(runFallback(contents, options)).toContain("unrelated-name.plist");
  });
});
