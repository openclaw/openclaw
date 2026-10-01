import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareLinuxInstalledApp, scanLinuxInstalledApps } from "./installed-apps-linux.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const appId = "linux-desktop:org.example.Calculator.desktop";
let directory: string;
let entry: string;
let executable: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  directory = tempDirs.make("installed-app-launch-");
  fs.mkdirSync(path.join(directory, "applications"));
  executable = path.join(directory, "calculator");
  fs.copyFileSync("/usr/bin/true", executable);
  fs.chmodSync(executable, 0o755);
  entry = path.join(directory, "applications", "org.example.Calculator.desktop");
  env = { XDG_DATA_HOME: directory, XDG_DATA_DIRS: directory, PATH: directory };
});
afterEach(() => vi.unstubAllEnvs());
function install(exec = executable, extra = "") {
  fs.writeFileSync(
    entry,
    ["[Desktop Entry]", "Type=Application", "Name=Calculator", "Exec=" + exec, extra, ""].join(
      "\n",
    ),
  );
}

describe.runIf(process.platform === "linux")("Linux installed app preparation", () => {
  it("lists a canonical app and binds its installed descriptor and executable revision", () => {
    install();
    const prepared = expectDefined(prepareLinuxInstalledApp(appId, env), "prepared native app");
    expect(prepared.executable).toBe(fs.realpathSync(executable));
    expect(prepared.app).toMatchObject({
      appId,
      label: "Calculator",
      appRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(scanLinuxInstalledApps(env).apps).toEqual([prepared.app]);
    install("/usr/bin/true");
    expect(
      expectDefined(prepareLinuxInstalledApp(appId, env), "prepared native app").app.appRevision,
    ).not.toBe(prepared.app.appRevision);
  });
  it.each([
    [String.raw`Example\sApp`, "Example App"],
    [String.raw`Example\\App`, String.raw`Example\App`],
    [String.raw`Example\qApp`, undefined],
  ])("decodes desktop string escapes before exposing labels: %s", (raw, label) => {
    install();
    fs.writeFileSync(
      entry,
      fs.readFileSync(entry, "utf8").replace("Name=Calculator", "Name=" + raw),
    );
    const prepared = prepareLinuxInstalledApp(appId, env);
    expect(prepared?.app.label).toBe(label);
    expect(scanLinuxInstalledApps(env).apps).toEqual(prepared ? [prepared.app] : []);
  });
  it.each([
    "calculator --new-window",
    "sh -c calculator",
    "calculator; echo unexpected",
    "calculator %U",
    "./calculator",
  ])("does not parse a command or argument escape: %s", (exec) => {
    install(exec);
    expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
  });
  it.each([
    "Terminal=true",
    "Hidden=true",
    "NoDisplay=true",
    "Path=/",
    "TryExec=missing",
    "OnlyShowIn=Other;",
    "NotShowIn=Other;",
    "DBusActivatable=true",
    "Exec=/bin/false",
  ])("rejects unsupported or ambiguous descriptor semantics: %s", (extra) => {
    install(executable, extra);
    expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
  });
  it.each(["Hidden = true", " Terminal = true ", "Path = /", "Exec = /usr/bin/false"])(
    "normalizes delimiter whitespace before eligibility and duplicate checks: %s",
    (extra) => {
      install(executable, extra);
      expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
    },
  );
  it.each(["Example App", "Example\\App"])(
    "accepts a quoted zero-argument executable path: %s",
    (name) => {
      const spaced = path.join(directory, name);
      fs.mkdirSync(spaced);
      const binary = path.join(spaced, "calculator");
      fs.copyFileSync(executable, binary);
      fs.chmodSync(binary, 0o755);
      // Desktop Entry requires four backslashes: value unescaping precedes Exec quoting.
      install('"' + binary.replaceAll("\\", "\\\\\\\\") + '"');
      expect(prepareLinuxInstalledApp(appId, env)?.executable).toBe(binary);
    },
  );
  it.each([1, 2, 3])(
    "rejects a quoted literal backslash encoded with %s source backslashes",
    (count) => {
      const slash = String.fromCharCode(92);
      const binary = path.join(directory, "Example" + slash + "App");
      fs.copyFileSync(executable, binary);
      fs.chmodSync(binary, 0o755);
      install('"' + binary.replaceAll(slash, slash.repeat(count)) + '"');
      expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
      expect(scanLinuxInstalledApps(env).apps).toEqual([]);
    },
  );
  it.each(['"', "$", String.fromCharCode(96)])(
    "requires both escape stages for quoted %s",
    (reserved) => {
      const slash = String.fromCharCode(92);
      const binary = path.join(directory, "Example" + reserved + "App");
      fs.copyFileSync(executable, binary);
      fs.chmodSync(binary, 0o755);
      install('"' + binary.replaceAll(reserved, slash + reserved) + '"');
      expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
      install('"' + binary.replaceAll(reserved, slash.repeat(2) + reserved) + '"');
      expect(prepareLinuxInstalledApp(appId, env)?.executable).toBe(binary);
    },
  );
  it("accepts a quoted bare executable without allowing another token", () => {
    install('"calculator"');
    expect(prepareLinuxInstalledApp(appId, env)?.executable).toBe(executable);
    install('"calculator" --extra');
    expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
    install('"calculator');
    expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
  });
  it("does not follow desktop-entry symlinks or launch scripts", () => {
    install();
    fs.renameSync(entry, entry + ".original");
    fs.symlinkSync(entry + ".original", entry);
    expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
    fs.unlinkSync(entry);
    install();
    fs.writeFileSync(executable, "#!/bin/sh\necho no\n");
    expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
  });
  it("rejects traversal and never falls through a masked user desktop entry", () => {
    install();
    expect(
      prepareLinuxInstalledApp("linux-desktop:../org.example.Calculator.desktop", env),
    ).toBeUndefined();
    const system = path.join(directory, "system");
    fs.mkdirSync(path.join(system, "applications"), { recursive: true });
    fs.copyFileSync(entry, path.join(system, "applications", path.basename(entry)));
    install(executable, "Hidden=true");
    expect(prepareLinuxInstalledApp(appId, { ...env, XDG_DATA_DIRS: system })).toBeUndefined();
  });
  it("revises identity when entry metadata or executable changes", () => {
    install();
    const original = expectDefined(prepareLinuxInstalledApp(appId, env), "prepared native app").app
      .appRevision;
    fs.appendFileSync(entry, "Comment=changed\n");
    const revised = expectDefined(prepareLinuxInstalledApp(appId, env), "prepared native app").app
      .appRevision;
    expect(revised).not.toBe(original);
    fs.renameSync(executable, executable + ".old");
    fs.copyFileSync(executable + ".old", executable);
    expect(
      expectDefined(prepareLinuxInstalledApp(appId, env), "prepared native app").app.appRevision,
    ).not.toBe(revised);
  });
  it("reports bounded or unreadable inventory honestly", () => {
    install();
    expect(scanLinuxInstalledApps(env).complete).toBe(true);
    const notDirectory = path.join(directory, "not-directory");
    fs.writeFileSync(notDirectory, "fixture");
    expect(scanLinuxInstalledApps({ ...env, XDG_DATA_DIRS: notDirectory }).complete).toBe(false);
    for (let index = 0; index < 2049; index++) {
      fs.writeFileSync(path.join(directory, "applications", index + ".desktop"), "");
    }
    expect(scanLinuxInstalledApps(env).complete).toBe(false);
  });
  it("rejects oversized or malformed desktop entries", () => {
    install(executable, "Hidden=TRUE");
    expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
    install(executable, "#".repeat(65537));
    expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
  });
  it("classifies the selected root while preserving user precedence", () => {
    install();
    const system = path.join(directory, "system");
    fs.mkdirSync(path.join(system, "applications"), { recursive: true });
    fs.copyFileSync(entry, path.join(system, "applications", path.basename(entry)));
    const roots = { ...env, XDG_DATA_DIRS: system };
    expect(prepareLinuxInstalledApp(appId, roots)?.app.system).toBe(false);
    fs.unlinkSync(entry);
    expect(prepareLinuxInstalledApp(appId, roots)?.app.system).toBe(true);
  });
  it("reports an unreadable entry as partial rather than an empty complete inventory", () => {
    install();
    fs.chmodSync(entry, 0);
    try {
      expect(scanLinuxInstalledApps(env)).toEqual({ apps: [], complete: false });
    } finally {
      fs.chmodSync(entry, 0o600);
    }
  });
});
