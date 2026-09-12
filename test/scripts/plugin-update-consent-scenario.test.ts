import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapters = vi.hoisted(() => ({
  spawn: vi.fn(),
  pack: vi.fn(),
  observe: vi.fn(),
  readIndex: vi.fn(),
  future: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: adapters.spawn, execFileSync: adapters.pack }));
vi.mock("../../scripts/e2e/lib/plugin-update/process-observer.mjs", () => ({
  observePostCoreCommand: adapters.observe,
}));
vi.mock("../../scripts/e2e/lib/plugin-index-sqlite.mjs", () => ({
  readPluginInstallIndex: adapters.readIndex,
}));
vi.mock("../../scripts/e2e/lib/update-first-hop-package-fixtures.mjs", () => ({
  packFutureUpdateFixture: adapters.future,
}));

import { runConsentScenario } from "../../scripts/e2e/lib/plugin-update/consent-scenario.mjs";

type Observation = { code: number; children: Array<{ argv: string[]; postCore: boolean }> };
class FixtureChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  observation: Observation = { code: 0, children: [] };
  kill() {
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0));
    return true;
  }
}

type Denial = {
  status: string;
  reason?: string;
  after: { version: string };
  postUpdate: {
    plugins: {
      status: string;
      warnings: Array<{ pluginId: string; reason: string }>;
      npm: { outcomes: Array<{ pluginId: string; status: string; code: string }> };
    };
  };
};
const pluginId = "update-consent-fixture";
const packageName = `@acme/${pluginId}`;
const consentCode = "PLUGIN_CAPABILITY_CONSENT_REQUIRED";
const roots: string[] = [];
let entry: string;
let coreTarball: string;
let configPath: string;
let installPath: string;
let enabled: boolean;
let available: number;
let installed: number;
let record: Record<string, unknown>;
let mutateDenial: ((result: Denial, repair: boolean, child: FixtureChild) => void) | undefined;
const packages = new Map<number, { code: string; integrity: string }>();
const coreVersions = new Map<string, string>();

function saveConfig() {
  fs.writeFileSync(
    configPath,
    JSON.stringify({ plugins: { entries: { [pluginId]: { enabled } } } }),
  );
}

function install(version: number) {
  const artifact = packages.get(version);
  if (!artifact) {
    throw new Error(`unprepared fixture ${version}`);
  }
  const tools = Array.from({ length: version }, (_, i) => `consent_tool_${i + 1}`);
  const surface = {
    channels: [],
    providers: [],
    tools,
    contracts: tools.map((tool) => `tools: ${tool}`),
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  };
  record = {
    version: `${version}.0.0`,
    installPath,
    spec: packageName,
    acceptedSurface: surface,
    acceptedSurfaceHash: createHash("sha256").update(JSON.stringify(surface)).digest("hex"),
    acceptedSurfaceIntegrity: artifact.integrity,
    integrity: artifact.integrity,
    acceptedSurfaceAt: 1,
  };
  installed = version;
  fs.mkdirSync(installPath, { recursive: true });
  fs.writeFileSync(path.join(installPath, "index.js"), artifact.code);
  fs.writeFileSync(
    path.join(installPath, "package.json"),
    JSON.stringify({ version: `${version}.0.0` }),
  );
  saveConfig();
}

// The CLI and registry are test doubles; the complete exported scenario and all its
// consent/payload assertions execute unchanged. No package install or service runs.
function cliReply(args: string[], child: FixtureChild): string {
  if (args[0] === "update" && args.includes("--help")) {
    return "--accept-capabilities";
  }
  if (args[0] === "plugins") {
    if (args[1] === "inspect") {
      return JSON.stringify({
        plugin: { status: enabled ? "loaded" : "disabled", enabled },
        install: record,
        tools: [
          {
            names: enabled
              ? Array.from({ length: installed }, (_, i) => `consent_tool_${i + 1}`)
              : [],
          },
        ],
      });
    }
    if (args[1] === "disable" || args[1] === "enable") {
      enabled = args[1] === "enable";
      saveConfig();
      return "";
    }
    if (args[1] === "install") {
      const spec = args[2] ?? "";
      const version = spec.startsWith("npm-pack:")
        ? Number(/fixture-(\d+)\.tgz$/.exec(spec)?.[1])
        : available;
      if (installed && version > installed && !args.includes("--accept-capabilities")) {
        child.observation.code = 1;
        return "requires capability consent";
      }
      install(version);
      return "";
    }
  }
  if (args[0] !== "update") {
    throw new Error(`unexpected CLI command: ${args.join(" ")}`);
  }
  const repair = args[1] === "repair";
  const coreVersion: string | undefined = repair
    ? JSON.parse(fs.readFileSync(path.resolve(path.dirname(entry), "..", "package.json"), "utf8"))
        .version
    : coreVersions.get(args[args.indexOf("--tag") + 1] ?? "");
  if (!coreVersion) {
    throw new Error("unprepared core update");
  }
  if (!repair) {
    fs.writeFileSync(
      path.resolve(path.dirname(entry), "..", "package.json"),
      JSON.stringify({ version: coreVersion }),
    );
    child.observation.children.push({ argv: ["node", "update", "post-core"], postCore: true });
  }
  if (args.includes("--accept-capabilities")) {
    install(available);
    return JSON.stringify({ status: "ok", after: { version: coreVersion } });
  }
  const result: Denial = {
    status: repair ? "warning" : "ok",
    after: { version: coreVersion },
    postUpdate: {
      plugins: {
        status: "warning",
        warnings: [{ pluginId, reason: "requires capability consent" }],
        npm: { outcomes: [{ pluginId, status: "error", code: consentCode }] },
      },
    },
  };
  mutateDenial?.(result, repair, child);
  return JSON.stringify(result);
}

beforeEach(() => {
  vi.clearAllMocks();
  packages.clear();
  coreVersions.clear();
  mutateDenial = undefined;
  available = 1;
  installed = 0;
  enabled = true;
  record = {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consent-scenario-contract-"));
  roots.push(root);
  entry = path.join(root, "host", "dist", "entry.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  coreTarball = path.join(root, "core.tgz");
  fs.writeFileSync(coreTarball, "core artifact placeholder; no archive reader is exercised");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir);
  configPath = path.join(stateDir, "openclaw.json");
  installPath = path.join(stateDir, "extensions", pluginId);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("NPM_CONFIG_REGISTRY", "");
  vi.stubEnv("npm_config_registry", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  adapters.readIndex.mockImplementation(() => ({
    installRecords: { [pluginId]: structuredClone(record) },
  }));
  adapters.observe.mockImplementation(async (child: FixtureChild) => child.observation);
  adapters.future.mockImplementation((_source: string, output: string, index: number) => {
    const targetVersion = `2026.9.${6 + index}`;
    coreVersions.set(output, targetVersion);
    return { targetVersion };
  });
  adapters.pack.mockImplementation((command: string, args: string[], options: { cwd: string }) => {
    expect(command).toBe("npm");
    expect(args.slice(0, 2)).toEqual(["pack", "--pack-destination"]);
    const version = Number(
      JSON.parse(fs.readFileSync(path.join(options.cwd, "package.json"), "utf8")).version.split(
        ".",
      )[0],
    );
    const artifactRoot = args[2];
    if (!artifactRoot || path.dirname(artifactRoot) !== os.tmpdir()) {
      throw new Error("expected isolated scenario artifact root");
    }
    if (!roots.includes(artifactRoot)) {
      roots.push(artifactRoot);
    }
    const filename = `fixture-${version}.tgz`;
    const bytes = Buffer.from(`fixture archive ${version}`);
    fs.writeFileSync(path.join(artifactRoot, filename), bytes);
    packages.set(version, {
      code: fs.readFileSync(path.join(options.cwd, "index.js"), "utf8"),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    });
    return filename;
  });
  adapters.spawn.mockImplementation(
    (command: string, args: string[], options: { stdio: unknown[] }) => {
      const child = new FixtureChild();
      if (
        command === process.execPath &&
        args[0] === "scripts/e2e/lib/plugins/npm-registry-server.mjs"
      ) {
        available = Math.max(
          ...args.filter((arg) => /^\d+\.0\.0$/.test(arg)).map(Number.parseFloat),
        );
        const portFile = args[1];
        if (!portFile) {
          throw new Error("missing registry port file");
        }
        fs.writeFileSync(portFile, "34567");
        return child;
      }
      expect(command).toBe("bash");
      const entryIndex = args.indexOf(entry);
      expect(entryIndex).toBeGreaterThan(0);
      const output = cliReply(args.slice(entryIndex + 1), child);
      const descriptor = options.stdio[1];
      if (typeof descriptor !== "number") {
        throw new Error("expected scenario-owned stdout descriptor");
      }
      fs.writeSync(descriptor, output);
      return child;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("installed-CLI consent scenario report contract", () => {
  it("accepts successful core updates with explicit plugin refusal warnings and preserves consent boundaries", async () => {
    await expect(runConsentScenario(entry, coreTarball)).resolves.toBeUndefined();
    expect(installed).toBe(3);
    expect(fs.existsSync(path.join(installPath, "index.js"))).toBe(true);
  });

  it.each([
    [
      "missing plugin warning",
      (result: Denial) => {
        result.postUpdate.plugins.warnings = [];
      },
    ],
    [
      "missing denied outcome",
      (result: Denial) => {
        result.postUpdate.plugins.npm.outcomes = [];
      },
    ],
    [
      "wrong consent code",
      (result: Denial) => {
        result.postUpdate.plugins.npm.outcomes = [
          { pluginId, status: "error", code: "OTHER_ERROR" },
        ];
      },
    ],
    [
      "failed core update",
      (result: Denial) => {
        result.status = "error";
      },
    ],
    [
      "wrong resulting core version",
      (result: Denial) => {
        result.after.version = "2026.9.5";
      },
    ],
    [
      "unexpected top-level failure reason",
      (result: Denial) => {
        result.reason = "post-update-plugins";
      },
    ],
    [
      "plugin error instead of warning",
      (result: Denial) => {
        result.postUpdate.plugins.status = "error";
      },
    ],
  ] as const)(
    "rejects %s rather than accepting a generic successful exit",
    async (_name, mutate) => {
      mutateDenial = (result, repair) => {
        if (!repair) {
          mutate(result);
        }
      };
      await expect(runConsentScenario(entry, coreTarball)).rejects.toThrow();
    },
  );

  it("rejects a nonzero core exit even with an otherwise valid warning report", async () => {
    mutateDenial = (_result, repair, child) => {
      if (!repair) {
        child.observation.code = 1;
      }
    };
    await expect(runConsentScenario(entry, coreTarball)).rejects.toThrow();
  });

  it("rejects a consent warning attributed to another plugin", async () => {
    mutateDenial = (result) => {
      result.postUpdate.plugins.warnings = [
        { pluginId: "another-plugin", reason: "requires capability consent" },
      ];
    };
    await expect(runConsentScenario(entry, coreTarball)).rejects.toThrow();
  });

  it("requires standalone repair to report warning, not core-update ok", async () => {
    mutateDenial = (result, repair) => {
      if (repair) {
        result.status = "ok";
      }
    };
    await expect(runConsentScenario(entry, coreTarball)).rejects.toThrow();
  });

  it.each([false, true])(
    "rejects payload widening despite a warning (repair: %s)",
    async (repairStep) => {
      mutateDenial = (_result, repair) => {
        if (repair === repairStep) {
          install(available);
        }
      };
      await expect(runConsentScenario(entry, coreTarball)).rejects.toThrow();
    },
  );

  it("still rejects a restart after a denied plugin update", async () => {
    mutateDenial = (_result, repair, child) => {
      if (!repair) {
        child.observation.children.push({ argv: ["gateway", "restart"], postCore: false });
      }
    };
    await expect(runConsentScenario(entry, coreTarball)).rejects.toThrow(
      "denied update attempted a Gateway restart",
    );
  });
});
