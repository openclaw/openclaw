import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = "scripts/create-dmg.sh";

function makeApp(
  entries: Record<string, string> = {
    CFBundleName: "OpenClaw",
    CFBundleShortVersionString: "2026.6.16",
  },
): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-create-dmg-"));
  tempDirs.push(dir);
  const app = path.join(dir, "OpenClaw.app");
  const contents = path.join(app, "Contents");
  mkdirSync(contents, { recursive: true });
  const dict = Object.entries(entries)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join("");
  writeFileSync(
    path.join(contents, "Info.plist"),
    `<plist version="1.0"><dict>${dict}</dict></plist>`,
    "utf8",
  );
  return app;
}

function makeFakeDmgTools() {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-create-dmg-tools-"));
  tempDirs.push(dir);
  const bin = path.join(dir, "bin");
  const hdiutilLog = path.join(dir, "hdiutil.log");
  const osascriptLog = path.join(dir, "osascript.applescript");
  mkdirSync(bin, { recursive: true });
  const executable = (name: string, script: string) => {
    const file = path.join(bin, name);
    writeFileSync(file, script, "utf8");
    chmodSync(file, 0o755);
  };
  executable(
    "hdiutil",
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$HDIUTIL_LOG"
command_name="\${1:-}"
shift || true
if [[ "\${HDIUTIL_FAIL_ON:-}" == "$command_name" ]]; then
  exit 17
fi
value_after() {
  local key="$1"; shift
  while (($#)); do
    if [[ "$1" == "$key" ]]; then printf '%s' "$2"; return; fi
    shift
  done
}
case "$command_name" in
  create)
    : > "\${!#}"
    ;;
  attach)
    printf '%s' "$1" > "\${HDIUTIL_LOG}.image"
    if [[ "\${HDIUTIL_ATTACH_EAGAIN:-0}" == "1" ]]; then
      echo "hdiutil: attach failed - Resource temporarily unavailable" >&2
      exit 35
    fi
    mountpoint="$(value_after -mountpoint "$@")"
    if [[ "\${HDIUTIL_ATTACH_MARKER:-0}" == "1" && -n "$mountpoint" ]]; then
      mkdir -p "$mountpoint"
      printf mounted > "$mountpoint/live-volume-file"
    fi
    printf '%s' "$mountpoint" > "\${HDIUTIL_LOG}.attached"
    printf '/dev/disk99\tGUID_partition_scheme\t\n/dev/disk99s1\tApple_HFS\t%s\n' "$mountpoint"
    ;;
  detach)
    if [[ "\${HDIUTIL_DETACH_FAIL:-0}" == "1" ]]; then
      exit 9
    fi
    detach_attempts_file="\${HDIUTIL_LOG}.detach-attempts"
    detach_attempts=0
    if [[ -f "$detach_attempts_file" ]]; then
      detach_attempts="$(cat "$detach_attempts_file")"
    fi
    detach_attempts=$((detach_attempts + 1))
    printf '%s' "$detach_attempts" > "$detach_attempts_file"
    vanish_at="\${HDIUTIL_DETACH_VANISH_AT:-0}"
    if (( vanish_at > 0 && detach_attempts >= vanish_at )); then
      rm -f "\${HDIUTIL_LOG}.attached" "\${HDIUTIL_LOG}.image"
      echo "hdiutil: detach failed - No such file or directory" >&2
      exit 1
    fi
    if (( detach_attempts <= \${HDIUTIL_DETACH_FAIL_COUNT:-0} )); then
      exit 9
    fi
    rm -f "\${HDIUTIL_LOG}.attached" "\${HDIUTIL_LOG}.image"
    ;;
  info)
    images=""
    if [[ -f "\${HDIUTIL_LOG}.image" ]]; then
      images="<dict><key>image-path</key><string>$(cat "\${HDIUTIL_LOG}.image")</string><key>system-entities</key><array><dict><key>dev-entry</key><string>/dev/disk99</string></dict><dict><key>dev-entry</key><string>/dev/disk99s1</string></dict></array></dict>"
    fi
    printf '<plist version="1.0"><dict><key>images</key><array>%s</array></dict></plist>\\n' "$images"
    ;;
  resize)
    if [[ "\${1:-}" == "-limits" ]]; then
      printf '100 200 300\\n'
    fi
    ;;
  convert)
    output="$(value_after -o "$@")"
    [[ -n "$output" ]]
    printf 'converted' > "$output"
    ;;
  verify)
    [[ -f "\${1:-}" ]]
    ;;
esac
`,
  );
  executable("osascript", '#!/usr/bin/env bash\ncat > "$OSASCRIPT_LOG"\nexit 0\n');
  for (const command of ["sleep", "sync"]) {
    executable(command, `#!/bin/bash\nprintf '${command} %s\\n' "$*" >> "$HDIUTIL_LOG"\n`);
  }
  executable(
    "mount",
    `#!/bin/bash
echo '/dev/disk1s1 on / (apfs, sealed, local, read-only, journaled)'
[[ -f "$HDIUTIL_LOG.attached" ]] && echo "/dev/disk99s1 on $(cat "$HDIUTIL_LOG.attached") (hfs, local, nobrowse)"
exit 0
`,
  );
  return {
    env: {
      HDIUTIL_LOG: hdiutilLog,
      OSASCRIPT_LOG: osascriptLog,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SKIP_DMG_STYLE: "1",
    },
    hdiutilLog,
    osascriptLog,
  };
}

function runScript(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function fixture(subdirectory = "") {
  const app = makeApp();
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-create-dmg-output-"));
  tempDirs.push(root);
  const outputDir = path.join(root, subdirectory);
  const output = path.join(outputDir, "OpenClaw.dmg");
  const tools = makeFakeDmgTools();
  return {
    outputDir,
    output,
    tools,
    run: (env: NodeJS.ProcessEnv = {}) => runScript([app, output], { ...tools.env, ...env }),
  };
}

function expectPrivateDmgMount(log: string): string {
  const attach = log.match(/^attach (.+)\/image-rw\.dmg -mountpoint (.+) -nobrowse$/m);
  const runRoot = attach?.[1];
  const mountPoint = attach?.[2];
  if (!runRoot || !mountPoint) {
    throw new Error("Expected a DMG attach command with image and mount paths");
  }
  // TMPDIR may itself live under /Volumes; ownership comes from the per-run root.
  expect(path.relative(tmpdir(), runRoot)).toMatch(/^openclaw-dmg\.[^/]+$/);
  expect(mountPoint).toBe(path.join(runRoot, "mount"));
  const detachTargets = Array.from(
    log.matchAll(/^detach (.+?)(?: -(?:quiet|force))?$/gm),
    ([, target]) => target,
  );
  expect(detachTargets).toContain(mountPoint);
  expect(detachTargets.filter((target) => target !== "/dev/disk99s1")).toEqual(
    detachTargets.filter((target) => target === mountPoint),
  );
  return mountPoint;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("create-dmg plist validation", () => {
  it("keeps resize-limit scratch data private to the run", () => {
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain('DMG_LIMITS_PATH="$DMG_TEMP/resize-limits.txt"');
    expect(script).toContain('hdiutil resize -limits "$DMG_RW_PATH" >"$DMG_LIMITS_PATH"');
    expect(script).not.toContain("/tmp/openclaw-dmg-limits.txt");
  });

  it.runIf(process.platform === "darwin")(
    "fails before hdiutil when required plist keys are missing",
    () => {
      const app = makeApp({ CFBundleName: "OpenClaw" });
      const result = runScript([app, path.join(path.dirname(app), "out.dmg")]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Does Not Exist");
      expect(result.stdout).not.toContain("Creating DMG:");
    },
  );
});

describe.runIf(process.platform === "darwin")("create-dmg ownership boundaries", () => {
  it.each(["", "nested/artifacts"])(
    "publishes to %s without touching caller siblings",
    (subdirectory) => {
      const { outputDir, output, tools, run } = fixture(subdirectory);
      const sibling = path.join(outputDir, "OpenClaw-rw.dmg");
      if (!subdirectory) {
        writeFileSync(output, "previous output", "utf8");
        writeFileSync(sibling, "caller owned", "utf8");
      }

      const result = run();

      expect(result.status).toBe(0);
      expect(readFileSync(output, "utf8")).toBe("converted");
      expect(existsSync(outputDir)).toBe(true);
      if (!subdirectory) {
        expect(readFileSync(sibling, "utf8")).toBe("caller owned");
      }
      const log = readFileSync(tools.hdiutilLog, "utf8");
      expectPrivateDmgMount(log);
      expect(log).toContain("convert ");
      // hdiutil sizes -srcfolder images with filesystem overhead; an explicit
      // byte estimate underallocates bundles containing many small files.
      const create = log.split("\n").find((line) => line.startsWith("create "));
      expect(create).toContain("-srcfolder ");
      expect(create).not.toMatch(/\s-(?:size|megabytes|sectors)\s/);
      expect(log).toContain("final.dmg");
      expect(log).toContain(`${outputDir}${path.sep}.openclaw-dmg.`);
      expect(log).not.toContain(sibling);
    },
  );

  it.each([
    [
      "malformed",
      { DMG_WINDOW_BOUNDS: "400 nope 900 420" },
      "DMG_WINDOW_BOUNDS must contain only integer values",
    ],
    [
      "multiline",
      { DMG_WINDOW_BOUNDS: "400 100 900 420\nnope" },
      "DMG_WINDOW_BOUNDS must be a single line",
    ],
    [
      "invalid resize slack",
      { DMG_EXTRA_SECTORS: "-1" },
      "DMG_EXTRA_SECTORS must be a finite non-negative integer",
    ],
  ] satisfies [string, NodeJS.ProcessEnv, string][])(
    "fails before image creation with %s",
    (_name, env, error) => {
      const { output, tools, run } = fixture();
      const result = run(env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(error);
      expect(existsSync(output)).toBe(false);
      expect(existsSync(tools.hdiutilLog) ? readFileSync(tools.hdiutilLog, "utf8") : "").toBe("");
    },
  );

  it("preserves an existing output when verification fails", () => {
    const { output, tools, run } = fixture();
    writeFileSync(output, "previous output", "utf8");

    const result = run({ HDIUTIL_FAIL_ON: "verify" });

    expect(result.status).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe("previous output");
    const log = readFileSync(tools.hdiutilLog, "utf8");
    expect(log).toContain("convert ");
    expect(log).toContain("final.dmg");
  });

  it("fails before resize and conversion when its private mount cannot detach", () => {
    const { tools, run } = fixture();

    const result = run({
      HDIUTIL_ATTACH_MARKER: "1",
      HDIUTIL_DETACH_FAIL: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Failed to detach DMG mount");
    expect(result.stderr).toContain("Preserving DMG temp root");
    const log = readFileSync(tools.hdiutilLog, "utf8");
    const mountPoint = expectPrivateDmgMount(log);
    expect(log).not.toContain("resize");
    expect(log).not.toContain("convert");
    // Nine polite attempts, three forced rounds by device then path, and the
    // EXIT trap's last cleanup attempt.
    expect(log.match(/^detach /gm)).toHaveLength(16);
    expect(log.match(/^detach \/dev\/disk99s1 -force$/gm)).toHaveLength(4);
    expect(log).toContain(`detach ${mountPoint} -force`);
    expect(readFileSync(path.join(mountPoint, "live-volume-file"), "utf8")).toBe("mounted");
    rmSync(path.dirname(mountPoint), { recursive: true, force: true });
  });

  it.each([false, true])(
    "detaches an RW image that a failed attach left without a mount (detach fails: %s)",
    (detachFails) => {
      const { output, tools, run } = fixture();

      const result = run({
        HDIUTIL_ATTACH_EAGAIN: "1",
        HDIUTIL_DETACH_FAIL: detachFails ? "1" : "0",
      });

      expect(result.status, result.stderr).toBe(detachFails ? 1 : 35);
      const log = readFileSync(tools.hdiutilLog, "utf8");
      const image = log.match(/^attach (.+) -mountpoint /m)?.[1] ?? "";
      expect(path.basename(image)).toBe("image-rw.dmg");
      const runRoot = path.dirname(image);
      tempDirs.push(runRoot);
      expect(
        log
          .slice(log.indexOf("\nattach ") + 1)
          .trim()
          .split("\n"),
      ).toEqual([
        `attach ${image} -mountpoint ${path.join(runRoot, "mount")} -nobrowse`,
        "info -plist",
        "detach -quiet /dev/disk99",
        "info -plist",
      ]);
      expect(log).not.toContain("-force");
      expect(existsSync(output)).toBe(false);
      expect(existsSync(image)).toBe(detachFails);
      expect(result.stderr).toContain("hdiutil: attach failed - Resource temporarily unavailable");
      if (detachFails) {
        expect(result.stderr).toContain(
          `ERROR: disk image ${image} is still attached; detach it with: hdiutil detach /dev/disk99\n`,
        );
        expect(result.stderr).toContain(
          `Error: Preserving DMG temp root because its RW image is still attached: ${runRoot}\n`,
        );
      } else {
        expect(result.stderr).not.toContain("Preserving DMG temp root");
      }
    },
  );

  it.each([
    ["vanishes before force", 9, 5, 5],
    ["vanishes during force", 9, 10, 11],
    ["recovers with quiet detach", 6, 0, 7],
    ["recovers with forced detach", 9, 0, 10],
  ] as const)("finalizes an image that %s", (_name, failures, vanishAt, count) => {
    const { output, tools, run } = fixture();
    const result = run({
      HDIUTIL_DETACH_FAIL_COUNT: String(failures),
      HDIUTIL_DETACH_VANISH_AT: String(vanishAt),
    });
    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("converted");
    expect(result.stderr).not.toContain("Preserving DMG temp root");
    const log = readFileSync(tools.hdiutilLog, "utf8");
    const mountPoint = expectPrivateDmgMount(log);
    const detaches = log.split("\n").filter((line) => line.startsWith("detach "));
    expect(detaches).toHaveLength(count);
    if (vanishAt) {
      expect(existsSync(path.dirname(mountPoint))).toBe(false);
      expect(detaches.filter((line) => line.endsWith("-force"))).toEqual(
        vanishAt === 10 ? ["detach /dev/disk99s1 -force", `detach ${mountPoint} -force`] : [],
      );
    } else {
      expect(detaches.slice(0, -1).every((line) => line.endsWith("-quiet"))).toBe(true);
      expect(detaches.at(-1)).toMatch(failures === 9 ? /-force$/ : /-quiet$/);
      expect(log.indexOf("sync ")).toBeGreaterThan(log.indexOf("attach "));
      expect(log.indexOf("sync ")).toBeLessThan(log.indexOf("sleep "));
      const delays = Array.from(log.matchAll(/^sleep (\d+)$/gm), ([, delay]) => Number(delay));
      expect(delays).toHaveLength(Math.min(failures + 1, 9));
      expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(failures === 9 ? 54 : 35);
    }
    expect(log).toContain("resize");
    expect(log).toContain("convert ");
  });

  it("styles the private mount without closing unrelated Finder windows", () => {
    const { tools, run } = fixture();

    const result = run({ SKIP_DMG_STYLE: "0" });

    expect(result.status).toBe(0);
    const applescript = readFileSync(tools.osascriptLog, "utf8");
    expect(applescript).toContain('set dmgRoot to POSIX file "');
    expect(applescript).toContain('/mount" as alias');
    expect(applescript).toContain("set dmgDisk to disk of dmgRoot");
    expect(applescript).not.toContain('tell disk "OpenClaw"');
    expect(applescript).not.toContain("close every window");
  });
});
