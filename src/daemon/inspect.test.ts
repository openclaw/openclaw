// Daemon inspect tests cover service inspection and diagnostic output.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { detectMarkerLineWithGateway } from "./inspect-markers.js";
import {
  findExtraGatewayServices,
  findSystemGatewayServices,
  listManagedOpenClawGatewayServices,
  renderGatewayServiceCleanupHints,
} from "./inspect.js";

const nativePlistHost = vi.hoisted(() => process.platform === "darwin");
vi.mock("../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/exec.js")>();
  const { decodeLaunchAgentPlistFixture } = await import("./launchd-plist.test-support.js");
  return {
    ...actual,
    runExec: vi.fn(async (...args: Parameters<typeof actual.runExec>) => {
      if (nativePlistHost) {
        return actual.runExec(...args);
      }
      const options = args[2];
      const input = typeof options === "object" ? options.input : undefined;
      if (input === undefined) {
        throw new Error("Native parser requires captured plist bytes");
      }
      return decodeLaunchAgentPlistFixture(input, args[1][1]);
    }),
  };
});

// File-scope cleanup cannot prevent the nested platform-restoration hooks from running.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Real content from the openclaw-gateway.service unit file (the canonical gateway unit).
const GATEWAY_SERVICE_CONTENTS = `\
[Unit]
Description=OpenClaw Gateway
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /home/openclaw/.npm-global/lib/node_modules/openclaw/dist/entry.js gateway --port 18789
Restart=always
Environment=OPENCLAW_SERVICE_MARKER=openclaw
Environment=OPENCLAW_SERVICE_KIND=gateway

[Install]
WantedBy=default.target
`;

// Real content from the openclaw-test.service unit file (a non-gateway openclaw service).
const TEST_SERVICE_CONTENTS = `\
[Unit]
Description=OpenClaw test service
After=default.target

[Service]
Type=simple
ExecStart=/bin/sh -c 'while true; do sleep 60; done'
Restart=on-failure

[Install]
WantedBy=default.target
`;

const CLAWDBOT_GATEWAY_CONTENTS = `\
[Unit]
Description=Clawdbot Gateway
[Service]
ExecStart=/usr/bin/node /opt/clawdbot/dist/entry.js gateway --port 18789
Environment=HOME=/home/clawdbot
`;

const COMPANION_SERVICE_CONTENTS = `\
[Unit]
Description=OpenClaw companion worker
After=openclaw-gateway.service
Requires=openclaw-gateway.service

[Service]
ExecStart=/usr/bin/node /opt/openclaw-worker/dist/index.js worker
`;

const CUSTOM_OPENCLAW_GATEWAY_CONTENTS = `\
[Unit]
Description=Custom OpenClaw gateway

[Service]
ExecStart=/usr/bin/node /opt/openclaw/dist/entry.js gateway --port 18888
`;

describe("detectMarkerLineWithGateway", () => {
  it("returns null for openclaw-test.service (openclaw only in description, no gateway on same line)", () => {
    expect(detectMarkerLineWithGateway(TEST_SERVICE_CONTENTS)).toBeNull();
  });

  it("returns openclaw for the canonical gateway unit (ExecStart has both openclaw and gateway)", () => {
    expect(detectMarkerLineWithGateway(GATEWAY_SERVICE_CONTENTS)).toBe("openclaw");
  });

  it("returns clawdbot for a clawdbot gateway unit", () => {
    expect(detectMarkerLineWithGateway(CLAWDBOT_GATEWAY_CONTENTS)).toBe("clawdbot");
  });

  it.each([
    "ExecStart=/usr/bin/openclaw \\\n  gateway",
    "# comment \\\nExecStart=/usr/bin/openclaw gateway",
    "; comment \\\nExecStart=/usr/bin/openclaw gateway",
    "ExecStart=/usr/bin/openclaw \\\n# comment\n  gateway",
  ])("detects commands through native comments and continuations: %s", (command) => {
    expect(detectMarkerLineWithGateway(`[Service]\n${command}\n`)).toBe("openclaw");
  });

  it("ignores gateway mentions in environment values instead of an executable directive", () => {
    expect(detectMarkerLineWithGateway("Environment=openclaw gateway\n")).toBeNull();
  });

  it("ignores non-gateway ExecStart commands that only pass gateway-named options", () => {
    const contents = `[Service]\nExecStart=/usr/bin/openclaw-helper --gateway-url http://127.0.0.1:18789 sync\n`;
    expect(detectMarkerLineWithGateway(contents)).toBeNull();
  });
});

describe("renderGatewayServiceCleanupHints", () => {
  it("does not suggest removing a gateway when no extra service was detected", () => {
    expect(renderGatewayServiceCleanupHints([])).toEqual([]);
  });

  it.each([
    {
      title: "targets the detected macOS LaunchAgent instead of the active gateway",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
      scope: "user",
      firstHint: "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      secondHint: "rm /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
    },
    {
      title: "uses the system domain for a detected macOS LaunchDaemon",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Library/LaunchDaemons/com.example.openclaw-gateway.plist",
      scope: "system",
      firstHint: "sudo launchctl bootout system/com.example.openclaw-gateway",
      secondHint: "sudo rm /Library/LaunchDaemons/com.example.openclaw-gateway.plist",
    },
    {
      title: "keeps global macOS LaunchAgents in the GUI domain",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Library/LaunchAgents/com.example.openclaw-gateway.plist",
      scope: "system",
      firstHint: "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      secondHint: "sudo rm /Library/LaunchAgents/com.example.openclaw-gateway.plist",
    },
    {
      title: "inspects the detected user-level systemd unit without removing it",
      platform: "linux",
      serviceName: "custom-gateway.service",
      source: "unit: /home/test/.config/systemd/user/custom-gateway.service",
      scope: "user",
      firstHint: "systemctl --user status -- custom-gateway.service",
      secondHint: "systemctl --user cat -- custom-gateway.service",
    },
    {
      title: "inspects the detected system-level systemd unit without removing it",
      platform: "linux",
      serviceName: "custom-gateway.service",
      source: "unit: /etc/systemd/system/custom-gateway.service",
      scope: "system",
      firstHint: "systemctl --system status -- custom-gateway.service",
      secondHint: "systemctl --system cat -- custom-gateway.service",
    },
    {
      title: "terminates systemctl options before a detected unit that begins with a dash",
      platform: "linux",
      serviceName: "-custom-gateway.service",
      source: "unit: /home/test/.config/systemd/user/-custom-gateway.service",
      scope: "user",
      firstHint: "systemctl --user status -- -custom-gateway.service",
      secondHint: "systemctl --user cat -- -custom-gateway.service",
    },
    {
      title: "shell-quotes detected POSIX service labels and paths",
      platform: "darwin",
      serviceName: "com.example.gateway; touch injected",
      source: "plist: /Users/test/Launch Agents/example's gateway.plist",
      scope: "user",
      firstHint: "launchctl bootout gui/$UID/'com.example.gateway; touch injected'",
      secondHint: "rm '/Users/test/Launch Agents/example'\\''s gateway.plist'",
    },
  ] as const)("$title", ({ platform, serviceName, source, scope, firstHint, secondHint }) => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform,
          label: serviceName,
          detail: source,
          scope,
        },
      ]),
    ).toEqual([firstHint, secondHint]);
  });

  it("inspects the detected Windows scheduled task without suggesting removal", () => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform: "win32",
          label: "\\OpenClaw Gateway Backup",
          detail: "task: \\OpenClaw Gateway Backup",
          scope: "system",
        },
      ]),
    ).toEqual(['schtasks /Query /TN "\\OpenClaw Gateway Backup" /V /FO LIST']);
  });

  it.each(["$(Start-Process calc)", "%OPENCLAW_GATEWAY_TASK%", "unsafe&task", "task`name"])(
    "does not render a Windows task name expandable by cmd.exe or PowerShell: %s",
    (label) => {
      expect(
        renderGatewayServiceCleanupHints([
          {
            platform: "win32",
            label,
            detail: `task: ${label}`,
            scope: "system",
          },
        ]),
      ).toEqual([]);
    },
  );

  it("does not invent a removal path when service metadata omits it", () => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform: "darwin",
          label: "com.example.openclaw-gateway",
          detail: "loaded",
          scope: "user",
        },
      ]),
    ).toEqual(["launchctl bootout gui/$UID/com.example.openclaw-gateway"]);
  });
});

describe("findExtraGatewayServices (linux / scanSystemdDir) — real filesystem", () => {
  // These tests write real .service files to a temp dir and call findExtraGatewayServices
  // with that dir as HOME. No platform mocking or fs mocking needed.
  const isLinux = process.platform === "linux";

  it.skipIf(!isLinux)("does not report openclaw-test.service as a gateway service", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(path.join(systemdDir, "openclaw-test.service"), TEST_SERVICE_CONTENTS);
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual({ services: [], errors: [] });
  });

  it.skipIf(!isLinux)(
    "does not report the canonical openclaw-gateway.service as an extra service",
    async () => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(
        path.join(systemdDir, "openclaw-gateway.service"),
        GATEWAY_SERVICE_CONTENTS,
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toStrictEqual({ services: [], errors: [] });
    },
  );

  it.skipIf(!isLinux)(
    "reports a legacy clawdbot-gateway service as an extra gateway service",
    async () => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      const unitPath = path.join(systemdDir, "clawdbot-gateway.service");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(unitPath, CLAWDBOT_GATEWAY_CONTENTS);
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result.services).toEqual([
        {
          platform: "linux",
          label: "clawdbot-gateway.service",
          detail: `unit: ${unitPath}`,
          scope: "user",
          marker: "clawdbot",
          legacy: true,
        },
      ]);
    },
  );

  it.skipIf(!isLinux)("reports an orphaned legacy systemd backup", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    const backupPath = path.join(systemdDir, "clawdbot-gateway.service.bak");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(backupPath, CLAWDBOT_GATEWAY_CONTENTS);

    const result = await findExtraGatewayServices({ HOME: tmpHome });

    expect(result.services).toEqual([
      {
        platform: "linux",
        label: "clawdbot-gateway.service",
        detail: `unit backup: ${backupPath}`,
        scope: "user",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
  });

  it.skipIf(!isLinux)("reports a legacy systemd unit and its backup once", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    const unitPath = path.join(systemdDir, "clawdbot-gateway.service");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(unitPath, CLAWDBOT_GATEWAY_CONTENTS);
    await fs.writeFile(`${unitPath}.bak`, CLAWDBOT_GATEWAY_CONTENTS);

    const result = await findExtraGatewayServices({ HOME: tmpHome });

    expect(result.services).toEqual([
      {
        platform: "linux",
        label: "clawdbot-gateway.service",
        detail: `unit: ${unitPath}`,
        scope: "user",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
  });

  it.skipIf(!isLinux)(
    "does not report companion units that only depend on the gateway",
    async () => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(
        path.join(systemdDir, "openclaw-companion.service"),
        COMPANION_SERVICE_CONTENTS,
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toStrictEqual({ services: [], errors: [] });
    },
  );

  it.skipIf(!isLinux).each(["", "# comment \\\n", "; comment \\\n"])(
    "reports custom-named gateway units after a physical comment: %j",
    async (comment) => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      const unitPath = path.join(systemdDir, "custom-openclaw.service");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(
        unitPath,
        CUSTOM_OPENCLAW_GATEWAY_CONTENTS.replace("ExecStart=", `${comment}ExecStart=`),
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result.services).toEqual([
        {
          platform: "linux",
          label: "custom-openclaw.service",
          detail: `unit: ${unitPath}`,
          scope: "user",
          marker: "openclaw",
          legacy: false,
        },
      ]);
    },
  );
});

describe("findExtraGatewayServices (darwin / scanLaunchdDir) — real filesystem", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("does not report LaunchAgent companions that only mention the gateway label", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      path.join(launchdDir, "com.example.companion.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.companion</string>
<key>KeepAlive</key><dict><key>OtherJobEnabled</key><dict><key>ai.openclaw.gateway</key><true/></dict></dict>
<key>ProgramArguments</key><array><string>/usr/local/bin/openclaw-helper</string><string>sync</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual({ services: [], errors: [] });
  });

  it("does not report LaunchAgent companions that only pass gateway-named options", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      path.join(launchdDir, "com.example.companion-options.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.companion-options</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/openclaw-helper</string><string>--gateway-url</string><string>http://127.0.0.1:18789</string><string>sync</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual({ services: [], errors: [] });
  });

  it("does not report non-gateway LaunchAgents that mention clawdbot in environment values", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      path.join(launchdDir, "com.github.facebook.watchman.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.github.facebook.watchman</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/Users/test/Projects/clawdbot2/node_modules/.bin:/opt/homebrew/bin</string></dict>
<key>ProgramArguments</key><array><string>/opt/homebrew/bin/watchman</string><string>--foreground</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual({ services: [], errors: [] });
  });

  it("reports a malformed recognizable plist without inventing a cleanup target", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    const plistPath = path.join(launchdDir, "ai.openclaw.backup.plist");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(plistPath, "not a plist");

    const result = await findExtraGatewayServices({ HOME: tmpHome });

    expect(result).toEqual({
      services: [],
      errors: [{ source: plistPath, message: expect.stringContaining("could not be inspected") }],
    });
    expect(renderGatewayServiceCleanupHints(result.services)).toEqual([]);
  });

  it("reports a service directory read failure as incomplete inspection", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    await fs.mkdir(path.dirname(launchdDir), { recursive: true });
    await fs.writeFile(launchdDir, "not a directory");

    const result = await findExtraGatewayServices({ HOME: tmpHome });

    expect(result).toEqual({
      services: [],
      errors: [{ source: launchdDir, message: expect.stringContaining("could not be inspected") }],
    });
  });

  it("reports custom LaunchAgents that execute openclaw gateway", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    const plistPath = path.join(launchdDir, "com.example.openclaw-gateway.plist");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.openclaw-gateway</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/openclaw</string><string>gateway</string><string>--port</string><string>18888</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result.services).toEqual([
      {
        platform: "darwin",
        label: "com.example.openclaw-gateway",
        detail: `plist: ${plistPath}`,
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
    expect(renderGatewayServiceCleanupHints(result.services)).toEqual([
      "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      `rm ${plistPath}`,
    ]);
  });
});

describe("managed Gateway inventory projections", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  function isolateNativeRoots(home: string) {
    const roots = [
      "/etc/systemd/system",
      "/usr/lib/systemd/system",
      "/lib/systemd/system",
      "/Library/LaunchAgents",
      "/Library/LaunchDaemons",
    ].map((root) => path.normalize(root));
    const mapPath = (value: string) => {
      const normalized = path.normalize(value);
      return roots.some(
        (root) => normalized === root || normalized.startsWith(`${root}${path.sep}`),
      )
        ? path.join(home, "native", normalized.slice(path.parse(normalized).root.length))
        : value;
    };
    const readdir = fs.readdir;
    const readFile = fs.readFile;
    vi.spyOn(fs, "readdir").mockImplementation((...args: Parameters<typeof fs.readdir>) => {
      if (typeof args[0] === "string") {
        args[0] = mapPath(args[0]);
      }
      return readdir(...args);
    });
    vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (typeof args[0] === "string") {
        args[0] = mapPath(args[0]);
      }
      return readFile(...args);
    });
    return async (file: string, contents: string) => {
      const target = mapPath(file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents);
    };
  }

  it.each([
    ["literal", "Environment=OPENCLAW_SERVICE_MARKER=openclaw OPENCLAW_SERVICE_KIND=gateway", true],
    [
      "spaced",
      "Environment = OPENCLAW_SERVICE_MARKER=openclaw OPENCLAW_SERVICE_KIND=gateway",
      true,
    ],
    [
      "tabbed",
      "Environment\t=\tOPENCLAW_SERVICE_MARKER=openclaw OPENCLAW_SERVICE_KIND=gateway",
      true,
    ],
    [
      "reset",
      "Environment=OPENCLAW_SERVICE_MARKER=openclaw OPENCLAW_SERVICE_KIND=gateway\nEnvironment = ",
      false,
    ],
    [
      "last Node kind",
      "Environment=OPENCLAW_SERVICE_MARKER=openclaw OPENCLAW_SERVICE_KIND=gateway\nEnvironment = OPENCLAW_SERVICE_KIND=node",
      false,
    ],
    [
      "other section",
      "[Unit]\nEnvironment=OPENCLAW_SERVICE_MARKER=openclaw OPENCLAW_SERVICE_KIND=gateway",
      false,
    ],
    [
      "wrong directive case",
      "environment=OPENCLAW_SERVICE_MARKER=openclaw OPENCLAW_SERVICE_KIND=gateway",
      false,
    ],
    [
      "legacy marker",
      "Environment=OPENCLAW_SERVICE_MARKER=clawdbot OPENCLAW_SERVICE_KIND=gateway",
      false,
    ],
  ] as const)(
    "uses %s inline metadata for an unbranded systemd command",
    async (_name, metadata, included) => {
      Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
      const home = tempDirs.make("managed-systemd-metadata-", os.tmpdir());
      const write = isolateNativeRoots(home);
      for (const unitPath of [
        path.join(home, ".config/systemd/user/custom.service"),
        "/etc/systemd/system/custom.service",
      ]) {
        await write(
          unitPath,
          `[Service]\nExecStart = /usr/bin/node /srv/worker/dist/entry.js gateway run\n${metadata}\n`,
        );
      }

      const managed = await listManagedOpenClawGatewayServices({ HOME: home });

      expect(managed).toEqual({
        services: included
          ? ["user", "system"].map((scope) =>
              expect.objectContaining({
                label: "custom.service",
                scope,
                marker: "openclaw",
                legacy: false,
              }),
            )
          : [],
        errors: [],
      });
      expect(await findSystemGatewayServices()).toEqual(
        included
          ? [
              expect.objectContaining({
                label: "custom.service",
                scope: "system",
                marker: "openclaw",
                legacy: false,
              }),
            ]
          : [],
      );
      expect(await findExtraGatewayServices({ HOME: home }, { deep: true })).toEqual({
        services: [],
        errors: [],
      });
    },
  );

  it("includes current, sibling, custom, and template systemd Gateways while preserving incomplete inspection", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    const home = tempDirs.make("managed-systemd-", os.tmpdir());
    const write = isolateNativeRoots(home);
    const userDir = path.join(home, ".config/systemd/user");
    for (const name of ["openclaw-gateway", "openclaw-gateway-dev", "rescue"]) {
      await write(path.join(userDir, `${name}.service`), CUSTOM_OPENCLAW_GATEWAY_CONTENTS);
    }
    await write("/etc/systemd/system/openclaw@.service", CUSTOM_OPENCLAW_GATEWAY_CONTENTS);
    await write("/usr/lib/systemd/system/vendor-gateway.service", CUSTOM_OPENCLAW_GATEWAY_CONTENTS);
    await write(
      path.join(userDir, "openclaw-node.service"),
      '[Service]\nExecStart=/usr/bin/openclaw node run\nEnvironment="OPENCLAW_SERVICE_MARKER=openclaw" "OPENCLAW_SERVICE_KIND=node" "OPENCLAW_GATEWAY_TOKEN=synthetic-token"\n',
    );
    for (const [name, args] of [
      ["named-node", 'node run --display-name "Home Gateway"'],
      ["exact-node", "node run --display-name gateway"],
      ["profile-node", "--profile gateway node run"],
    ]) {
      await write(
        path.join(userDir, `${name}.service`),
        `[Service]\nExecStart=/usr/bin/node /opt/openclaw/openclaw.mjs ${args}\n`,
      );
    }
    await write(
      path.join(userDir, "runtime-options.service"),
      "[Service]\nExecStart=/usr/bin/node -C development --import /opt/bootstrap.mjs /opt/clawdbot/dist/entry.js --profile rescue gateway run\n",
    );
    await write(path.join(userDir, "clawdbot-gateway.service"), CLAWDBOT_GATEWAY_CONTENTS);
    await write(path.join(userDir, "clawdbot-upgraded.service"), CUSTOM_OPENCLAW_GATEWAY_CONTENTS);
    await write(
      path.join(userDir, "shell.service"),
      `[Service]\nExecStart=/bin/sh -c 'NODE_ENV=production exec /usr/bin/openclaw --profile rescue gateway run'\n`,
    );
    await write(
      path.join(userDir, "shell-node.service"),
      `[Service]\nExecStart=/bin/sh -c 'exec /usr/bin/openclaw node run --display-name "Home Gateway"'\n`,
    );
    await write(
      path.join(userDir, "env.service"),
      "[Service]\nExecStart=/usr/bin/env NODE_ENV=production node /opt/clawdbot/dist/entry.js gateway run\n",
    );
    await write("/lib/systemd/system", "unreadable service directory");

    const managed = await listManagedOpenClawGatewayServices({ HOME: home });
    const extras = await findExtraGatewayServices({ HOME: home }, { deep: true });

    expect(managed.services.map((service) => service.label).toSorted()).toEqual([
      "clawdbot-upgraded.service",
      "openclaw-gateway-dev.service",
      "openclaw-gateway.service",
      "openclaw@.service",
      "rescue.service",
      "shell.service",
      "vendor-gateway.service",
    ]);
    expect(managed.services).toContainEqual({
      platform: "linux",
      label: "openclaw@.service",
      scope: "system",
      detail: `unit: ${path.join("/etc/systemd/system", "openclaw@.service")}`,
      marker: "openclaw",
      legacy: false,
    });
    const expectedExtras = [
      "clawdbot-gateway.service",
      "clawdbot-upgraded.service",
      "env.service",
      "openclaw@.service",
      "rescue.service",
      "runtime-options.service",
      "shell.service",
      "vendor-gateway.service",
    ];
    expect(extras.services.map((service) => service.label).toSorted()).toEqual(expectedExtras);
    for (const selected of [
      "rescue.service",
      "clawdbot-gateway.service",
      "clawdbot-upgraded.service",
      "vendor-gateway.service",
    ]) {
      const env = { HOME: home, OPENCLAW_SYSTEMD_UNIT: selected };
      const selectedExtras = await findExtraGatewayServices(env, { deep: true });
      const omitted = selected === "rescue.service" ? selected : undefined;
      expect(selectedExtras.services.map((service) => service.label).toSorted()).toEqual(
        expectedExtras.filter((label) => label !== omitted),
      );
      expect(selectedExtras.errors).toEqual(extras.errors);
      expect(await listManagedOpenClawGatewayServices(env)).toEqual(managed);
    }
    expect(extras.errors).toEqual([
      { source: "/lib/systemd/system", message: expect.stringContaining("could not be inspected") },
    ]);
    expect(managed.errors).toEqual(extras.errors);
    for (const service of [...managed.services, ...extras.services]) {
      expect(service).not.toHaveProperty("extra");
      expect(service).not.toHaveProperty("managedGateway");
    }
  });

  it.each([
    {
      name: "default",
      label: "ai.openclaw.gateway",
      env: {},
      executable: "/usr/bin/openclaw",
      metadata: "",
    },
    {
      name: "named profile",
      label: "ai.openclaw.rescue",
      env: { OPENCLAW_PROFILE: "rescue" },
      executable: "/usr/bin/openclaw",
      metadata: "",
    },
    {
      name: "custom managed label",
      label: "org.example.rescue",
      env: { OPENCLAW_LAUNCHD_LABEL: "org.example.rescue" },
      executable: "/usr/bin/worker",
      metadata:
        "<key>EnvironmentVariables</key><dict><key>OPENCLAW_SERVICE_MARKER</key><string>openclaw</string><key>OPENCLAW_SERVICE_KIND</key><string>gateway</string></dict>",
    },
  ])(
    "reports global copies of the $name user LaunchAgent",
    async ({ label, env, executable, metadata }) => {
      Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
      const home = tempDirs.make("launchd-global-copies-", os.tmpdir());
      const write = isolateNativeRoots(home);
      const plist = `<plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${executable}</string><string>gateway</string></array>${metadata}</dict></plist>`;
      const globalPaths = [
        `/Library/LaunchAgents/${label}.plist`,
        `/Library/LaunchDaemons/${label}.plist`,
      ];
      for (const file of [
        path.join(home, "Library/LaunchAgents", `${label}.plist`),
        ...globalPaths,
      ]) {
        await write(file, plist);
      }

      const inventory = await findExtraGatewayServices({ HOME: home, ...env }, { deep: true });

      expect(inventory).toEqual({
        services: globalPaths.map((file) => ({
          platform: "darwin",
          label,
          detail: `plist: ${file}`,
          scope: "system",
          marker: "openclaw",
          legacy: false,
        })),
        errors: [],
      });
    },
  );

  it("reports global and custom launchd extras without admitting authenticated Node jobs", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    const home = tempDirs.make("managed-launchd-", os.tmpdir());
    const write = isolateNativeRoots(home);
    const userDir = path.join(home, "Library/LaunchAgents");
    const plist = (label: string, executable = "openclaw", command = "gateway") =>
      `<plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/${executable}</string><string>${command}</string></array></dict></plist>`;
    for (const label of ["ai.openclaw.gateway", "ai.openclaw.gateway.dev", "org.example.rescue"]) {
      await write(path.join(userDir, `${label}.plist`), plist(label));
    }
    await write("/Library/LaunchAgents/org.example.global.plist", plist("org.example.global"));
    await write("/Library/LaunchDaemons/ai.openclaw.gateway.plist", plist("ai.openclaw.gateway"));
    for (const [label, args] of [
      [
        "org.example.shell",
        [
          "/bin/sh",
          "-c",
          "NODE_ENV=production exec /usr/bin/openclaw --profile rescue gateway run",
        ],
      ],
      [
        "org.example.env",
        ["/usr/bin/env", "NODE_ENV=production", "node", "/opt/openclaw/openclaw.mjs", "gateway"],
      ],
      [
        "org.example.shell-node",
        ["/bin/sh", "-c", 'exec /usr/bin/openclaw node run --display-name "Home Gateway"'],
      ],
      [
        "org.example.named-node",
        [
          "/usr/bin/node",
          "/opt/openclaw/openclaw.mjs",
          "node",
          "run",
          "--display-name",
          "Home Gateway",
        ],
      ],
      [
        "org.example.wrapped",
        [
          "/bin/sh",
          "/opt/service-env/rescue-env-wrapper.sh",
          "/opt/service-env/rescue.env",
          "/usr/bin/node",
          "--import",
          "/opt/bootstrap.mjs",
          "/opt/openclaw/openclaw.mjs",
          "--profile",
          "rescue",
          "gateway",
        ],
      ],
      [
        "org.example.direct-wrapper",
        [
          "/opt/service-env/rescue-env-wrapper.sh",
          "/opt/service-env/rescue.env",
          "/usr/bin/openclaw",
          "gateway",
        ],
      ],
      [
        "org.example.wrapped-node",
        [
          "/bin/sh",
          "/opt/service-env/rescue-env-wrapper.sh",
          "/opt/service-env/rescue.env",
          "/usr/bin/openclaw",
          "node",
          "run",
          "--display-name",
          "gateway",
        ],
      ],
      [
        "org.example.direct-wrapped-node",
        [
          "/opt/service-env/rescue-env-wrapper.sh",
          "/opt/service-env/rescue.env",
          "/usr/bin/openclaw",
          "--profile",
          "gateway",
          "node",
          "run",
        ],
      ],
    ] as const) {
      await write(
        path.join(userDir, `${label}.plist`),
        `<plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${arg}</string>`).join("")}</array></dict></plist>`,
      );
    }
    await write(
      path.join(userDir, "org.example.program.plist"),
      plist("org.example.program", "alias").replace(
        "<key>ProgramArguments</key>",
        "<key>Program</key><string>/usr/bin/openclaw</string><key>ProgramArguments</key>",
      ),
    );
    await write(
      path.join(userDir, "org.example.argv-alias.plist"),
      plist("org.example.argv-alias").replace(
        "<key>ProgramArguments</key>",
        "<key>Program</key><string>/usr/bin/node</string><key>ProgramArguments</key>",
      ),
    );
    await write(
      "/Library/LaunchDaemons/ai.openclaw.node.plist",
      plist("ai.openclaw.node", "openclaw", "node").replace(
        "</dict>",
        "<key>EnvironmentVariables</key><dict><key>OPENCLAW_SERVICE_MARKER</key><string>openclaw</string><key>OPENCLAW_SERVICE_KIND</key><string>node</string><key>OPENCLAW_GATEWAY_TOKEN</key><string>synthetic-token</string></dict></dict>",
      ),
    );
    await write(
      path.join(userDir, "com.clawdbot.gateway.plist"),
      plist("com.clawdbot.gateway", "clawdbot"),
    );
    const unreadable = path.join(userDir, "ai.openclaw.broken.plist");
    await write(unreadable, "malformed plist");

    const managed = await listManagedOpenClawGatewayServices({ HOME: home });
    const extras = await findExtraGatewayServices({ HOME: home }, { deep: true });

    expect(
      managed.services.map((service) => `${service.scope}:${service.label}`).toSorted(),
    ).toEqual([
      "system:ai.openclaw.gateway",
      "system:org.example.global",
      "user:ai.openclaw.gateway",
      "user:ai.openclaw.gateway.dev",
      "user:org.example.direct-wrapper",
      "user:org.example.env",
      "user:org.example.program",
      "user:org.example.rescue",
      "user:org.example.shell",
      "user:org.example.wrapped",
    ]);
    const expectedExtras = [
      "system:ai.openclaw.gateway",
      "system:org.example.global",
      "user:com.clawdbot.gateway",
      "user:org.example.direct-wrapper",
      "user:org.example.env",
      "user:org.example.program",
      "user:org.example.rescue",
      "user:org.example.shell",
      "user:org.example.wrapped",
    ];
    expect(
      extras.services.map((service) => `${service.scope}:${service.label}`).toSorted(),
    ).toEqual(expectedExtras);
    for (const selected of [
      "org.example.rescue",
      "com.clawdbot.gateway",
      "org.example.global",
      "ai.openclaw.gateway",
    ]) {
      const env = { HOME: home, OPENCLAW_LAUNCHD_LABEL: selected };
      const selectedExtras = await findExtraGatewayServices(env, { deep: true });
      const omitted = selected === "org.example.rescue" ? `user:${selected}` : undefined;
      expect(
        selectedExtras.services.map((service) => `${service.scope}:${service.label}`).toSorted(),
      ).toEqual(expectedExtras.filter((label) => label !== omitted));
      expect(selectedExtras.errors).toEqual(extras.errors);
      expect(await listManagedOpenClawGatewayServices(env)).toEqual(managed);
    }
    expect(extras.errors).toEqual([
      { source: unreadable, message: expect.stringContaining("could not be inspected") },
    ]);
    expect(managed.errors).toEqual(extras.errors);
    for (const service of [...managed.services, ...extras.services]) {
      expect(service).not.toHaveProperty("extra");
      expect(service).not.toHaveProperty("managedGateway");
    }
  });
});
