import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveLiveManagedGatewayDistFence } from "../../scripts/lib/live-gateway-dist-fence.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
vi.mock("./systemd-loaded-unit-inventory.js", async (original) => ({
  ...(await original<typeof import("./systemd-loaded-unit-inventory.js")>()),
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const CLAWDBOT_GATEWAY_CONTENTS =
  "[Service]\nExecStart=/usr/bin/node /opt/clawdbot/dist/entry.js gateway --port 18789\n";
const CUSTOM_OPENCLAW_GATEWAY_CONTENTS =
  "[Service]\nExecStart=/usr/bin/node /opt/openclaw/dist/entry.js gateway --port 18888\n";

function plist(
  label: string,
  args = ["/usr/bin/openclaw", "gateway"],
  program = "",
  metadata = "",
) {
  const strings = args.map((arg) => `<string>${arg}</string>`).join("");
  return `<plist><dict><key>Label</key><string>${label}</string>${program ? `<key>Program</key><string>${program}</string>` : ""}<key>ProgramArguments</key><array>${strings}</array>${metadata}</dict></plist>`;
}
const unitLabels = (names: string) => names.split(" ").map((name) => `${name}.service`);
const scopedLabels = (system: string, user: string) => [
  ...system.split(" ").map((label) => `system:${label}`),
  ...user.split(" ").map((label) => `user:${label}`),
];

const serviceMetadata = (kind: string) =>
  `<key>EnvironmentVariables</key><dict><key>OPENCLAW_SERVICE_MARKER</key><string>openclaw</string><key>OPENCLAW_SERVICE_KIND</key><string>${kind}</string></dict>`;

it.skipIf(process.platform !== "linux")("reports an orphaned legacy systemd backup", async () => {
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
    return roots.some((root) => normalized === root || normalized.startsWith(`${root}${path.sep}`))
      ? path.join(home, "native", normalized.slice(path.parse(normalized).root.length))
      : value;
  };
  const { readdir, readFile } = fs;
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

function nativeFixture(platform: "linux" | "darwin", prefix = "openclaw-inventory-") {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  const home = tempDirs.make(prefix, os.tmpdir());
  return {
    home,
    write: isolateNativeRoots(home),
    userDir: path.join(
      home,
      platform === "linux" ? ".config/systemd/user" : "Library/LaunchAgents",
    ),
  };
}

async function expectProjections(
  home: string,
  expected: {
    managed: string[];
    extras: string[];
    selected: string[];
    selector: string;
    omitted: string;
    errorSource: string;
    scoped?: boolean;
  },
) {
  const labels = (inventory: Awaited<ReturnType<typeof findExtraGatewayServices>>) =>
    inventory.services
      .map(({ scope, label }) => (expected.scoped ? `${scope}:${label}` : label))
      .toSorted();
  const managed = await listManagedOpenClawGatewayServices({ HOME: home });
  const extras = await findExtraGatewayServices({ HOME: home }, { deep: true });
  expect(labels(managed)).toEqual(expected.managed);
  expect(labels(extras)).toEqual(expected.extras);
  for (const selected of expected.selected) {
    const env = { HOME: home, [expected.selector]: selected };
    const selectedExtras = await findExtraGatewayServices(env, { deep: true });
    const omitted =
      selected === expected.omitted ? `${expected.scoped ? "user:" : ""}${selected}` : undefined;
    expect(labels(selectedExtras)).toEqual(expected.extras.filter((label) => label !== omitted));
    expect(selectedExtras.errors).toEqual(extras.errors);
    expect(await listManagedOpenClawGatewayServices(env)).toEqual(managed);
  }
  expect(extras.errors).toEqual([
    { source: expected.errorSource, message: expect.stringContaining("could not be inspected") },
  ]);
  expect(managed.errors).toEqual(extras.errors);
  for (const service of [...managed.services, ...extras.services]) {
    expect(service).not.toHaveProperty("extra");
    expect(service).not.toHaveProperty("managedGateway");
  }
  return managed;
}

it("resets inline metadata for an unbranded systemd command", async () => {
  const { home, write } = nativeFixture("linux", "managed-systemd-metadata-");
  for (const unitPath of [
    path.join(home, ".config/systemd/user/custom.service"),
    "/etc/systemd/system/custom.service",
  ]) {
    await write(
      unitPath,
      [
        "[Service]",
        "ExecStart = /usr/bin/node /srv/worker/dist/entry.js gateway run",
        "Environment=OPENCLAW_SERVICE_MARKER=openclaw OPENCLAW_SERVICE_KIND=gateway",
        "Environment = ",
        "",
      ].join("\n"),
    );
  }
  expect(await listManagedOpenClawGatewayServices({ HOME: home })).toEqual({
    services: [],
    errors: [],
  });
  expect(await findSystemGatewayServices()).toEqual([]);
  expect(await findExtraGatewayServices({ HOME: home }, { deep: true })).toEqual({
    services: [],
    errors: [],
  });
});

it("includes current, sibling, custom, and template systemd Gateways while preserving incomplete inspection", async () => {
  const { home, write, userDir } = nativeFixture("linux", "managed-systemd-");
  const writeCommand = (name: string, command: string) =>
    write(path.join(userDir, `${name}.service`), `[Service]\nExecStart=${command}\n`);

  for (const name of ["openclaw-gateway", "openclaw-gateway-dev", "rescue"]) {
    await write(path.join(userDir, `${name}.service`), CUSTOM_OPENCLAW_GATEWAY_CONTENTS);
  }
  await write("/etc/systemd/system/openclaw@.service", CUSTOM_OPENCLAW_GATEWAY_CONTENTS);
  await write("/usr/lib/systemd/system/vendor-gateway.service", CUSTOM_OPENCLAW_GATEWAY_CONTENTS);
  await write(
    path.join(userDir, "openclaw-node.service"),
    '[Service]\nExecStart=/usr/bin/openclaw node run\nEnvironment="OPENCLAW_SERVICE_MARKER=openclaw" "OPENCLAW_SERVICE_KIND=node"\n',
  );
  for (const [name, args] of [
    ["named-node", 'node run --display-name "Home Gateway"'],
    ["exact-node", "node run --display-name gateway"],
    ["profile-node", "--profile gateway node run"],
    ["install", "gateway install --runtime bun"],
    ["profile-install", "--profile rescue gateway --profile rescue install"],
    ["status", "gateway status --json"],
  ] as const) {
    await writeCommand(name, `/usr/bin/node /opt/openclaw/openclaw.mjs ${args}`);
  }
  await writeCommand(
    "runtime-options",
    "/usr/bin/node -C development --import /opt/bootstrap.mjs /opt/clawdbot/dist/entry.js --profile rescue gateway run",
  );
  await write(path.join(userDir, "clawdbot-gateway.service"), CLAWDBOT_GATEWAY_CONTENTS);
  await write(path.join(userDir, "clawdbot-upgraded.service"), CUSTOM_OPENCLAW_GATEWAY_CONTENTS);
  await writeCommand(
    "shell",
    "/bin/sh -c 'NODE_ENV=production exec /usr/bin/openclaw --profile rescue gateway run'",
  );
  await writeCommand(
    "shell-node",
    `/bin/sh -c 'exec /usr/bin/openclaw node run --display-name "Home Gateway"'`,
  );
  await writeCommand(
    "env",
    "/usr/bin/env NODE_ENV=production node /opt/clawdbot/dist/entry.js gateway run",
  );
  await write("/lib/systemd/system", "unreadable service directory");

  const managed = await expectProjections(home, {
    managed: unitLabels(
      "clawdbot-upgraded openclaw-gateway-dev openclaw-gateway openclaw@ rescue shell vendor-gateway",
    ),
    extras: unitLabels(
      "clawdbot-gateway clawdbot-upgraded env openclaw@ rescue runtime-options shell vendor-gateway",
    ),
    selected: unitLabels("rescue clawdbot-gateway clawdbot-upgraded vendor-gateway"),
    selector: "OPENCLAW_SYSTEMD_UNIT",
    omitted: "rescue.service",
    errorSource: "/lib/systemd/system",
  });
  const sourcePath = path.join("/etc/systemd/system", "openclaw@.service");
  expect(managed.services).toContainEqual({
    platform: "linux",
    label: "openclaw@.service",
    scope: "system",
    detail: `unit: ${sourcePath}`,
    sourcePath,
    marker: "openclaw",
    legacy: false,
  });
});

const commandCase = (
  args: string,
  options: {
    gateway?: boolean;
    executable?: string;
    executionPath?: string;
    additionalCommands?: string[][];
    name?: string;
  } = {},
) => ({ args: args.split(" "), gateway: true, ...options });
it.each([
  commandCase("gateway install --runtime bun", { gateway: false }),
  commandCase("gateway run"),
  commandCase("gateway --port 18888"),
  commandCase("gateway --token install"),
  commandCase("gateway --unknown install"),
  commandCase("gateway install", { executable: "/opt/openclaw/bin/custom-service" }),
  commandCase("/opt/openclaw/custom-service.js gateway install", { executable: "/usr/bin/node" }),
  commandCase("gateway install", { executable: "/usr/bin/openclaw-gateway" }),
  commandCase("--eval import('/opt/openclaw/dist/entry.js') gateway", {
    executable: "/usr/bin/node",
  }),
  commandCase("gateway install", {
    additionalCommands: [["/usr/bin/openclaw", "gateway", "run"]],
  }),
  commandCase("gateway install", { additionalCommands: [["/opt/custom-service"]] }),
  commandCase("gateway install", {
    additionalCommands: [["/usr/bin/openclaw", "gateway", "status"]],
    gateway: false,
  }),
  commandCase("gateway install", { name: "openclaw-gateway.service" }),
  commandCase("gateway install", { executionPath: "/opt/custom-service" }),
])(
  "uses captured arguments to classify loaded services: $args",
  async ({
    args,
    gateway,
    executable = "/usr/bin/openclaw",
    executionPath = executable,
    additionalCommands = [],
    name = "custom-maintenance.service",
  }) => {
    const { home } = nativeFixture("linux", "managed-systemd-command-");
    const unitPath = `/run/systemd/transient/${name}`;
    loadedSystemdUnits.mockImplementation(async (scope) =>
      scope === "system"
        ? [
            {
              name,
              fragmentPath: unitPath,
              commands: [
                { path: executionPath, programArguments: [executable, ...args] },
                ...additionalCommands.map((argv) => ({ path: argv[0]!, programArguments: argv })),
              ],
            },
          ]
        : [],
    );
    const result = await listManagedOpenClawGatewayServices({ HOME: home });
    expect(result.errors).toEqual([]);
    expect(result.services.map((service) => service.label)).toEqual(gateway ? [name] : []);
  },
);

it("keeps discovered native selectors independent of display details", async () => {
  const { home, write } = nativeFixture("linux", "managed-systemd-load-paths-");
  const configHome = path.join(home, "xdg-config");
  const dataHome = path.join(home, "xdg-data");
  const runtimeDir = path.join(home, "xdg-runtime");
  const unitPaths = [
    path.join(configHome, "systemd/user/config-gateway.service"),
    path.join(dataHome, "systemd/user/data-gateway.service"),
    "/etc/systemd/system.control/system-gateway.service",
    path.join(runtimeDir, "systemd/generator/generated-gateway.service"),
    path.join(runtimeDir, "systemd/transient/transient-gateway.service"),
    "/run/systemd/user/run-gateway.service",
    "/run/systemd/generator/system-generated-gateway.service",
  ];
  for (const unitPath of unitPaths) {
    await write(unitPath, CUSTOM_OPENCLAW_GATEWAY_CONTENTS);
  }

  const result = await listManagedOpenClawGatewayServices({
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_RUNTIME_DIR: runtimeDir,
  });

  expect(result.errors).toEqual([]);
  expect(result.services.map((service) => service.label).toSorted()).toEqual(
    unitLabels(
      "config-gateway data-gateway generated-gateway run-gateway system-gateway system-generated-gateway transient-gateway",
    ),
  );
  const inventory = await import("./inspect.js");
  for (const service of result.services) {
    service.detail = "Discovered Gateway";
  }
  vi.spyOn(inventory, "listManagedOpenClawGatewayServices").mockResolvedValue(result);
  const { discoverManagedGatewayBindings } = await import("./managed-gateway-bindings.js");
  const bindings = await discoverManagedGatewayBindings({ HOME: home });
  expect(bindings).toHaveLength(7);
  expect(bindings.map((binding) => binding.systemdReadTarget?.unitPath)).toEqual(
    expect.arrayContaining(unitPaths),
  );
});

it.each([
  {
    label: "ai.openclaw.rescue",
    env: { OPENCLAW_PROFILE: "rescue" },
  },
  {
    label: "org.example.rescue",
    env: { OPENCLAW_LAUNCHD_LABEL: "org.example.rescue" },
    executable: "/usr/bin/worker",
    metadata: serviceMetadata("gateway"),
  },
])(
  "reports global copies of the $label user LaunchAgent",
  async ({ label, env, executable = "/usr/bin/openclaw", metadata = "" }) => {
    const { home, write } = nativeFixture("darwin", "launchd-global-copies-");
    const contents = plist(label, [executable, "gateway"], "", metadata);
    const globalPaths = [
      `/Library/LaunchAgents/${label}.plist`,
      `/Library/LaunchDaemons/${label}.plist`,
    ];
    for (const file of [
      path.join(home, "Library/LaunchAgents", `${label}.plist`),
      ...globalPaths,
    ]) {
      await write(file, contents);
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
  const { home, write, userDir } = nativeFixture("darwin", "managed-launchd-");
  const writePlist = (label: string, args?: string[], program?: string) =>
    write(path.join(userDir, `${label}.plist`), plist(label, args, program));
  for (const label of ["ai.openclaw.gateway", "ai.openclaw.gateway.dev", "org.example.rescue"]) {
    await writePlist(label);
  }
  await write("/Library/LaunchAgents/org.example.global.plist", plist("org.example.global"));
  await write("/Library/LaunchDaemons/ai.openclaw.gateway.plist", plist("ai.openclaw.gateway"));
  const wrapper = ["/opt/service-env/rescue-env-wrapper.sh", "/opt/service-env/rescue.env"];
  const node = ["/usr/bin/node", "/opt/openclaw/openclaw.mjs"];
  const wrapped = (...args: string[]) => [...wrapper, ...args];
  const cli = "/usr/bin/openclaw";
  for (const [label, args] of [
    [
      "org.example.shell",
      ["/bin/sh", "-c", "NODE_ENV=production exec /usr/bin/openclaw --profile rescue gateway run"],
    ],
    [
      "org.example.env",
      ["/usr/bin/env", "NODE_ENV=production", "node", "/opt/openclaw/openclaw.mjs", "gateway"],
    ],
    [
      "org.example.shell-node",
      ["/bin/sh", "-c", 'exec /usr/bin/openclaw node run --display-name "Home Gateway"'],
    ],
    ["org.example.named-node", [...node, "node", "run", "--display-name", "Home Gateway"]],
    [
      "org.example.wrapped",
      [
        "/bin/sh",
        ...wrapper,
        "/usr/bin/node",
        "--import",
        "/opt/bootstrap.mjs",
        "/opt/openclaw/openclaw.mjs",
        "--profile",
        "rescue",
        "gateway",
      ],
    ],
    ["org.example.direct-wrapper", wrapped(cli, "gateway")],
    [
      "org.example.wrapped-node",
      ["/bin/sh", ...wrapped(cli, "node", "run", "--display-name", "gateway")],
    ],
    ["org.example.direct-wrapped-node", wrapped(cli, "--profile", "gateway", "node", "run")],
  ] as const) {
    await writePlist(label, [...args]);
  }
  await writePlist("org.example.program", ["/usr/bin/alias", "gateway"], "/usr/bin/openclaw");
  await writePlist("org.example.argv-alias", undefined, "/usr/bin/node");
  await write(
    "/Library/LaunchDaemons/ai.openclaw.node.plist",
    plist("ai.openclaw.node", ["/usr/bin/openclaw", "node"], "", serviceMetadata("node")),
  );
  await writePlist("com.clawdbot.gateway", ["/usr/bin/clawdbot", "gateway"]);
  const unreadable = path.join(userDir, "ai.openclaw.broken.plist");
  await write(unreadable, "malformed plist");

  await expectProjections(home, {
    managed: scopedLabels(
      "ai.openclaw.gateway org.example.global",
      "ai.openclaw.gateway ai.openclaw.gateway.dev org.example.direct-wrapper org.example.env org.example.program org.example.rescue org.example.shell org.example.wrapped",
    ),
    extras: scopedLabels(
      "ai.openclaw.gateway org.example.global",
      "com.clawdbot.gateway org.example.direct-wrapper org.example.env org.example.program org.example.rescue org.example.shell org.example.wrapped",
    ),
    selected: [
      "org.example.rescue",
      "com.clawdbot.gateway",
      "org.example.global",
      "ai.openclaw.gateway",
    ],
    selector: "OPENCLAW_LAUNCHD_LABEL",
    omitted: "org.example.rescue",
    errorSource: unreadable,
    scoped: true,
  });
});

function isolateDirectoryReads(home: string) {
  const readdir = fs.readdir;
  vi.spyOn(fs, "readdir").mockImplementation((...args: Parameters<typeof fs.readdir>) => {
    const dir = args[0];
    return typeof dir === "string" && (dir === home || dir.startsWith(`${home}${path.sep}`))
      ? readdir(...args)
      : Promise.resolve([]);
  });
}

it.each([
  ["linux", ".config/systemd/user/custom-worker.service", false],
  ["linux", ".config/systemd/user/openclaw-gateway.service", true],
  ["linux", ".config/systemd/user/clawdbot-gateway.service.bak", true],
] as const)(
  "handles unreadable paths in complete %s inventories: %s",
  async (platform, relative, required) => {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    const home = tempDirs.make("openclaw-incomplete-inventory-");
    isolateDirectoryReads(home);
    const unreadable = path.join(home, relative);
    // A directory in place of a service file fails reads even as root.
    await fs.mkdir(unreadable, { recursive: true });
    const expected = {
      services: [],
      errors: required
        ? [{ source: unreadable, message: "Service path could not be inspected." }]
        : [],
    };
    await expect(listManagedOpenClawGatewayServices({ HOME: home })).resolves.toEqual(expected);
  },
);

it("admits an unrelated unreadable launchd plist and still fences a live Gateway", async () => {
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  const home = tempDirs.make("openclaw-launchd-fence-");
  isolateDirectoryReads(home);
  const checkout = path.join(home, "openclaw");
  await fs.mkdir(path.join(checkout, "dist"), { recursive: true });
  await fs.writeFile(path.join(checkout, "package.json"), '{"name":"openclaw"}\n');
  await fs.writeFile(path.join(checkout, "dist", "index.js"), "gateway\n");
  const agents = path.join(home, "Library", "LaunchAgents");
  await fs.mkdir(path.join(agents, "org.example.custom-worker.plist"), { recursive: true });
  const label = "ai.openclaw.gateway.dev";
  const target = `gui/501/${label}`;
  const sourcePath = path.join(agents, `${label}.plist`);
  const programArguments = [process.execPath, path.join(checkout, "dist", "index.js"), "gateway"];
  vi.spyOn(launchdRuntime, "readLoadedLaunchAgentState").mockImplementation(async (env) => {
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
  const env = { HOME: home };
  await expect(
    resolveLiveManagedGatewayDistFence(checkout, { env, requireVerified: true }),
  ).resolves.toEqual({ refuse: false });

  await fs.writeFile(sourcePath, plist(label, programArguments));
  await expect(
    resolveLiveManagedGatewayDistFence(checkout, { env, requireVerified: true }),
  ).resolves.toMatchObject({
    refuse: true,
    message: expect.stringContaining(
      `launchd job ${JSON.stringify(target)} loaded from ${JSON.stringify(sourcePath)}`,
    ),
  });
});
