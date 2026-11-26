import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as ServiceModule from "../../daemon/service.js";
import type * as LockProcessModule from "../../infra/gateway-lock-process.js";
import type * as LockModule from "../../infra/gateway-lock.js";
import type * as RetainedRuntimeModule from "../../infra/update-retained-runtime.js";
import type * as RecoveryAdmissionModule from "../../infra/update-run-recovery-admission.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import type * as ReleaseCliModule from "../../update/cli.js";
import { checkUpdateInstallationSlot } from "../../update/installation-identity.js";
import { readTrial, resolvePrefix } from "../../update/store.js";
import type * as SharedModule from "./shared.js";
import type * as AdmissionModule from "./update-command-admission-report.js";
import type * as AdmittedModule from "./update-command-admitted.js";
import type * as ConfigModule from "./update-command-config.js";
import type * as EngineModule from "./update-command-database-engine.js";
import type * as ImmutableModule from "./update-command-immutable.js";
import type * as InitializationModule from "./update-command-initialization.js";
import type * as ActivationModule from "./update-command-package-activation.js";
import type * as RunModule from "./update-command-run.js";
import { updateCommand } from "./update-command.js";

const facts = vi.hoisted(() => ({
  root: "",
  serviceRoot: "",
  liveRoot: "",
  opaque: false,
  pid: 123,
  gateway: true,
  node: false,
  unreadable: false,
  kind: "package" as "git" | "package",
  storedChannel: "stable",
}));
const release = vi.hoisted(() => vi.fn(async (_options: unknown) => {}));
const legacy = vi.hoisted(() => vi.fn(async () => {}));

// Routing owns these decisions; external preparation and activation do no work in this fixture.
vi.mock("../../update/cli.js", async (original) => ({
  ...(await original<typeof ReleaseCliModule>()),
  runReleaseUpdateCli: release,
}));
vi.mock("../../daemon/service.js", async (original) => ({
  ...(await original<typeof ServiceModule>()),
  resolveGatewayService: (kind?: string) => ({
    hasInstalledDefinition: async () => (kind === "node" ? facts.node : facts.gateway),
    readCommand: async () => {
      if (facts.unreadable) {
        throw new Error("service inspection unavailable");
      }
      return facts.gateway || kind === "node"
        ? {
            programArguments: [
              process.execPath,
              path.join(facts.serviceRoot || facts.root, "dist/index.js"),
              kind === "node" ? "node" : "gateway",
            ],
          }
        : null;
    },
  }),
}));
vi.mock("../../infra/gateway-lock.js", async (original) => ({
  ...(await original<typeof LockModule>()),
  readActiveGatewayLockIdentity: async () =>
    facts.liveRoot ? { pid: facts.pid, port: 18789 } : undefined,
}));
vi.mock("../../infra/gateway-lock-process.js", async (original) => ({
  ...(await original<typeof LockProcessModule>()),
  readGatewayLockProcessCmdline: () =>
    facts.opaque
      ? ["openclaw-gateway"]
      : [process.execPath, path.join(facts.liveRoot, "dist/index.js"), "gateway"],
}));
vi.mock("../../infra/update-retained-runtime.js", async (original) => ({
  ...(await original<typeof RetainedRuntimeModule>()),
  withRetainedUpdateRuntime: async (_url: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("./update-command-immutable.js", async (original) => ({
  ...(await original<typeof ImmutableModule>()),
  tryRunImmutableUpdateCommand: async () => false,
}));
vi.mock("../../infra/update-run-recovery-admission.js", async (original) => ({
  ...(await original<typeof RecoveryAdmissionModule>()),
  assertUpdateRecoveryAdmission: async () => {},
}));
vi.mock("./update-command-run.js", async (original) => ({
  ...(await original<typeof RunModule>()),
  prepareUpdateCommand: async (opts: { channel?: string; restart?: boolean }) => ({
    discoveredRoot: facts.root,
    installKind: facts.kind,
    requestedChannel: opts.channel ?? null,
    shouldRestart: opts.restart !== false,
    timeoutMs: 5_000,
  }),
  resolveUpdateCommandAdmissionRoot: () => facts.root,
  resolveUpdateCommandAdmissionEnv: async () => process.env,
}));
vi.mock("./update-command-config.js", async (original) => ({
  ...(await original<typeof ConfigModule>()),
  readUpdateChannelConfig: async () => ({ storedChannel: facts.storedChannel }),
}));
vi.mock("./update-command-admission-report.js", async (original) => ({
  ...(await original<typeof AdmissionModule>()),
  withUpdateAdmissionReporting: async (_opts: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof SharedModule>()),
  assertGlobalUpdateOwner: async () => {},
  assertMacosGitForUnownedCheckout: async () => {},
}));
vi.mock("./update-command-database-engine.js", async (original) => ({
  ...(await original<typeof EngineModule>()),
  withUpdateDatabaseEngine: async (
    _env: unknown,
    run: (readable: boolean, malformed: boolean) => Promise<unknown>,
  ) => run(true, false),
}));
vi.mock("./update-command-package-activation.js", async (original) => ({
  ...(await original<typeof ActivationModule>()),
  assertUpdatePackageActivationAdmission: () => {},
}));
vi.mock("./update-command-initialization.js", async (original) => ({
  ...(await original<typeof InitializationModule>()),
  updateStateNeedsInitialization: async () => false,
}));
vi.mock("./update-command-admitted.js", async (original) => ({
  ...(await original<typeof AdmittedModule>()),
  runAdmittedUpdate: legacy,
}));

let home: TempHomeEnv;
async function packageAt(root: string) {
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "1.0.0" }),
  );
  await fs.writeFile(path.join(root, "dist/index.js"), "");
}
beforeEach(async () => {
  home = await createTempHomeEnv("update-release-owner-");
  facts.root = path.join(home.home, "package");
  facts.serviceRoot = facts.liveRoot = "";
  facts.opaque = false;
  facts.pid = 123;
  facts.gateway = true;
  facts.node = facts.unreadable = false;
  facts.kind = "package";
  facts.storedChannel = "stable";
  await packageAt(facts.root);
  release.mockClear();
  legacy.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await home.restore();
});
const options = () => ({ run: { runId: "routing-test", env: process.env } });
async function converted(relativeSlot = "openclaw") {
  const prefix = resolvePrefix();
  const selected = path.join(prefix, "releases", "selected", relativeSlot);
  await packageAt(selected);
  const slot = path.join(prefix, relativeSlot);
  await fs.mkdir(path.dirname(slot), { recursive: true });
  await fs.symlink(selected, slot, "junction");
}

it.each([
  [{ channel: "dev" }, "package", "openclaw"],
  [{ tag: "main" }, "package", "openclaw"],
  [{ channel: "stable" }, "git", "lib/node_modules/openclaw"],
] as const)(
  "refuses a converted installation's mutating route %j (%s, %s)",
  async (opts, kind, slot) => {
    facts.kind = kind;
    await converted(slot);
    expect(await readTrial()).toBeNull();
    await expect(updateCommand({ ...options(), ...opts })).rejects.toThrow("resident launcher");
    expect(legacy).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  },
);

it.each(["package", "git"] as const)(
  "routes an unconverted node-only %s installation through its owner",
  async (kind) => {
    facts.kind = kind;
    facts.gateway = false;
    facts.node = true;
    const sha = "a".repeat(40);
    await updateCommand({ ...options(), ...(kind === "git" ? { sha } : {}) });
    if (kind === "git") {
      expect(release).toHaveBeenCalledWith(expect.objectContaining({ sha }));
      expect(legacy).not.toHaveBeenCalled();
    } else {
      expect(legacy).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
    }
    await expect(fs.stat(resolvePrefix())).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(["1.2.3", "beta", "./openclaw.tgz", "npm:openclaw@1.2.3"])(
  "keeps documented package target %s on its release owner",
  async (tag) => {
    await updateCommand({ ...options(), tag, restart: false });
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ restart: false, tag: expect.any(String) }),
    );
    expect(legacy).not.toHaveBeenCalled();
  },
);

it("does not redirect an implicit Git update because a package channel was saved", async () => {
  facts.kind = "git";
  await updateCommand(options());
  expect(release).toHaveBeenCalledOnce();
  expect(legacy).not.toHaveBeenCalled();
});

it.each(["service", "foreground"])(
  "refuses a second root before first conversion (%s)",
  async (owner) => {
    const other = path.join(home.home, "owner");
    await packageAt(other);
    facts.gateway = owner === "service";
    if (owner === "service") {
      facts.serviceRoot = other;
    } else {
      facts.liveRoot = other;
    }
    await expect(checkUpdateInstallationSlot(facts.root)).rejects.toThrow(
      "not the invoking installation",
    );
    await expect(fs.stat(resolvePrefix())).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("does not turn unreadable service inspection into a new installation refusal", async () => {
  facts.unreadable = true;
  await expect(checkUpdateInstallationSlot(facts.root)).resolves.toBeUndefined();
});

it("refuses an opaque live foreground owner without inventing an installation root", async () => {
  facts.gateway = false;
  facts.liveRoot = facts.root;
  facts.opaque = true;
  await expect(checkUpdateInstallationSlot(facts.root)).rejects.toMatchObject({
    name: "UnverifiedForegroundUpdateOwnerError",
    message: expect.stringMatching(/Control UI.*operator access.*stop the Gateway/u),
  });
  await expect(fs.stat(resolvePrefix())).rejects.toMatchObject({ code: "ENOENT" });
});

it("lets the Gateway identify its own argv even when its OS title has no root", async () => {
  facts.gateway = false;
  facts.liveRoot = facts.root;
  facts.opaque = true;
  facts.pid = process.pid;
  const argv = process.argv;
  process.argv = [process.execPath, path.join(facts.root, "dist/index.js"), "gateway"];
  try {
    await expect(checkUpdateInstallationSlot(facts.root)).resolves.toBeUndefined();
  } finally {
    process.argv = argv;
  }
});
