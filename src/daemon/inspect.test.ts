// Daemon inspect tests cover service inspection and diagnostic output.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLiveManagedGatewayDistFence } from "../../scripts/lib/live-gateway-dist-fence.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  findExtraGatewayServices,
  findSystemGatewayServices,
  listManagedOpenClawGatewayServices,
} from "./inspect.js";
import * as launchdRuntime from "./launchd-runtime.js";

const nativePlistHost = vi.hoisted(() => process.platform === "darwin");
const loadedSystemdUnits = vi.hoisted(() =>
  vi.fn<typeof import("./systemd-loaded-unit-inventory.js").listLoadedSystemdUnits>(),
);
vi.mock("./systemd-loaded-unit-inventory.js", () => ({
  listLoadedSystemdUnits: loadedSystemdUnits,
}));
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

const CLAWDBOT_GATEWAY_CONTENTS = `\
[Unit]
Description=Clawdbot Gateway
[Service]
ExecStart=/usr/bin/node /opt/clawdbot/dist/entry.js gateway --port 18789
Environment=HOME=/home/clawdbot
`;

const CUSTOM_OPENCLAW_GATEWAY_CONTENTS = `\
[Unit]
Description=Custom OpenClaw gateway

[Service]
ExecStart=/usr/bin/node /opt/openclaw/dist/entry.js gateway --port 18888
`;

describe("findExtraGatewayServices (linux / scanSystemdDir) — real filesystem", () => {
  // These tests write real .service files to a temp dir and call findExtraGatewayServices
  // with that dir as HOME. No platform mocking or fs mocking needed.
  const isLinux = process.platform === "linux";

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
});

describe("managed Gateway inventory projections", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    loadedSystemdUnits.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  function isolateNativeRoots(home: string) {
    const roots = [
      "/etc/systemd",
      "/etc/xdg/systemd",
      "/run/systemd",
      "/run/user",
      "/usr/local/lib/systemd",
      "/usr/local/share/systemd",
      "/usr/lib/systemd",
      "/usr/share/systemd",
      "/lib/systemd",
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
    [
      "reset",
      "Environment=OPENCLAW_SERVICE_MARKER=openclaw OPENCLAW_SERVICE_KIND=gateway\nEnvironment = ",
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
      sourcePath: path.join("/etc/systemd/system", "openclaw@.service"),
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

  it("keeps discovered native selectors independent of display details", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    const home = tempDirs.make("managed-systemd-load-paths-", os.tmpdir());
    const write = isolateNativeRoots(home);
    const configHome = path.join(home, "xdg-config");
    const dataHome = path.join(home, "xdg-data");
    const runtimeDir = path.join(home, "xdg-runtime");
    await write(
      path.join(configHome, "systemd/user/config-gateway.service"),
      CUSTOM_OPENCLAW_GATEWAY_CONTENTS,
    );
    await write(
      path.join(dataHome, "systemd/user/data-gateway.service"),
      CUSTOM_OPENCLAW_GATEWAY_CONTENTS,
    );
    await write(
      "/etc/systemd/system.control/system-gateway.service",
      CUSTOM_OPENCLAW_GATEWAY_CONTENTS,
    );
    await write(
      path.join(runtimeDir, "systemd/generator/generated-gateway.service"),
      CUSTOM_OPENCLAW_GATEWAY_CONTENTS,
    );
    await write(
      path.join(runtimeDir, "systemd/transient/transient-gateway.service"),
      CUSTOM_OPENCLAW_GATEWAY_CONTENTS,
    );
    await write("/run/systemd/user/run-gateway.service", CUSTOM_OPENCLAW_GATEWAY_CONTENTS);
    await write(
      "/run/systemd/generator/system-generated-gateway.service",
      CUSTOM_OPENCLAW_GATEWAY_CONTENTS,
    );

    const result = await listManagedOpenClawGatewayServices(
      {
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_RUNTIME_DIR: runtimeDir,
      },
      { requireComplete: true },
    );

    expect(result.errors).toEqual([]);
    expect(result.services.map((service) => service.label).toSorted()).toEqual([
      "config-gateway.service",
      "data-gateway.service",
      "generated-gateway.service",
      "run-gateway.service",
      "system-gateway.service",
      "system-generated-gateway.service",
      "transient-gateway.service",
    ]);
    const inventory = await import("./inspect.js");
    for (const service of result.services) {
      service.detail = "Discovered Gateway";
    }
    vi.spyOn(inventory, "listManagedOpenClawGatewayServices").mockResolvedValue(result);
    const { discoverManagedGatewayBindings } = await import("./managed-gateway-bindings.js");
    const bindings = await discoverManagedGatewayBindings({ HOME: home });
    expect(bindings).toHaveLength(7);
    expect(bindings.map((binding) => binding.systemdReadTarget?.unitPath)).toEqual(
      expect.arrayContaining([
        path.join(configHome, "systemd/user/config-gateway.service"),
        path.join(dataHome, "systemd/user/data-gateway.service"),
        "/etc/systemd/system.control/system-gateway.service",
        path.join(runtimeDir, "systemd/generator/generated-gateway.service"),
        path.join(runtimeDir, "systemd/transient/transient-gateway.service"),
        "/run/systemd/user/run-gateway.service",
        "/run/systemd/generator/system-generated-gateway.service",
      ]),
    );
  });

  it.each([
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
          sourcePath: file,
          scope: "system",
          marker: "openclaw",
          legacy: false,
        })),
        errors: [],
      });
    },
  );

  it("includes user and global launchd Gateways without admitting Node or legacy jobs", async () => {
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

describe("complete inventory admission", () => {
  beforeEach(() => loadedSystemdUnits.mockReset().mockResolvedValue([]));
  it.each([
    ["linux", ".config/systemd/user/custom-worker.service", false],
    ["linux", ".config/systemd/user/openclaw-gateway.service", true],
  ] as const)(
    "handles unreadable paths in complete %s inventories: %s",
    async (platform, relative, required) => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { configurable: true, value: platform });
      try {
        await withTestDir({ prefix: "openclaw-incomplete-inventory-" }, async (home) => {
          const readdir = fs.readdir;
          const directories = vi
            .spyOn(fs, "readdir")
            .mockImplementation((...args: Parameters<typeof fs.readdir>) => {
              const dir = args[0];
              return typeof dir === "string" &&
                (dir === home || dir.startsWith(`${home}${path.sep}`))
                ? readdir(...args)
                : Promise.resolve([]);
            });
          try {
            const unreadable = path.join(home, relative);
            // A directory in place of a service file fails reads even as root.
            await fs.mkdir(unreadable, { recursive: true });
            await expect(listManagedOpenClawGatewayServices({ HOME: home })).resolves.toEqual({
              services: [],
              errors: required
                ? [{ source: unreadable, message: "Service path could not be inspected." }]
                : [],
            });
            await expect(
              listManagedOpenClawGatewayServices({ HOME: home }, { requireComplete: true }),
            ).resolves.toEqual({
              services: [],
              errors: required
                ? [{ source: unreadable, message: "Service path could not be inspected." }]
                : [],
            });
          } finally {
            directories.mockRestore();
          }
        });
      } finally {
        Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
      }
    },
  );

  it("admits an unrelated unreadable launchd plist and still fences a live Gateway", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    try {
      await withTestDir({ prefix: "openclaw-launchd-fence-" }, async (home) => {
        const checkout = path.join(home, "openclaw");
        await fs.mkdir(path.join(checkout, "dist"), { recursive: true });
        await fs.writeFile(path.join(checkout, "package.json"), '{"name":"openclaw"}\n');
        await fs.writeFile(path.join(checkout, "dist", "index.js"), "gateway\n");
        const agents = path.join(home, "Library", "LaunchAgents");
        await fs.mkdir(path.join(agents, "org.example.custom-worker.plist"), { recursive: true });
        const readdir = fs.readdir;
        const directories = vi
          .spyOn(fs, "readdir")
          .mockImplementation((...args: Parameters<typeof fs.readdir>) => {
            const dir = args[0];
            return typeof dir === "string" && (dir === home || dir.startsWith(`${home}${path.sep}`))
              ? readdir(...args)
              : Promise.resolve([]);
          });
        const label = "ai.openclaw.gateway.dev";
        const target = `gui/501/${label}`;
        const sourcePath = path.join(agents, `${label}.plist`);
        const programArguments = [
          process.execPath,
          path.join(checkout, "dist", "index.js"),
          "gateway",
        ];
        const readState = vi
          .spyOn(launchdRuntime, "readLoadedLaunchAgentState")
          .mockImplementation(async (env) => {
            const live = env.OPENCLAW_LAUNCHD_LABEL === label;
            return {
              installed: live,
              loadState: { status: live ? "loaded" : "not-loaded" },
              running: live,
              env,
              command: live ? { programArguments, sourcePath } : null,
              runtime: { status: live ? "running" : "stopped" },
              ...(live
                ? {
                    launchAgent: {
                      target,
                      sourcePath,
                      program: process.execPath,
                      programArguments,
                      environment: {},
                    },
                  }
                : {}),
            };
          });
        try {
          const env = { HOME: home };
          await expect(
            resolveLiveManagedGatewayDistFence(checkout, { env, requireVerified: true }),
          ).resolves.toEqual({ refuse: false });

          await fs.writeFile(
            sourcePath,
            `<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${path.join(checkout, "dist", "index.js")}</string><string>gateway</string></array></dict></plist>`,
          );
          await expect(
            resolveLiveManagedGatewayDistFence(checkout, { env, requireVerified: true }),
          ).resolves.toMatchObject({
            refuse: true,
            message: expect.stringContaining(
              `launchd job ${JSON.stringify(target)} loaded from ${JSON.stringify(sourcePath)}`,
            ),
          });
        } finally {
          readState.mockRestore();
          directories.mockRestore();
        }
      });
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });
});
