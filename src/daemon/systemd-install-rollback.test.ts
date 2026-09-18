import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertGatewayServiceUpdateCurrent,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";
import { installSystemdService } from "./systemd-install.js";

const native = vi.hoisted(() => ({
  exec: vi.fn<typeof import("./systemd-exec.js").execSystemctlUser>(),
  active: vi.fn<typeof import("./systemd-exec.js").isSystemdUnitActive>(),
  available: vi.fn<typeof import("./systemd-exec.js").assertSystemdAvailable>(),
  read: vi.fn<typeof import("./systemd-service-files.js").readSystemdServiceExecStart>(),
}));
vi.mock("./systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-exec.js")>()),
  assertSystemdAvailable: native.available,
  execSystemctlUser: native.exec,
  isSystemdUnitActive: native.active,
}));
vi.mock("./systemd-scope.js", () => ({ assertNoSystemGatewayOwnership: async () => {} }));
vi.mock("./systemd-service-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-service-files.js")>()),
  readSystemdServiceExecStart: native.read,
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  native.exec.mockReset();
  native.active.mockReset();
  native.available.mockReset().mockResolvedValue(undefined);
  native.read.mockReset().mockResolvedValue(null);
});

it.each([
  { enabled: "enabled", running: true, failure: "activation" },
  { enabled: "disabled", running: false, failure: "activation" },
  { enabled: "enabled-runtime", running: true, failure: "activation" },
  { enabled: "enabled", running: true, failure: "availability-read" },
  { enabled: "enabled", running: true, failure: "definition-read" },
  { enabled: "enabled", running: true, failure: "policy-read" },
])("preserves the previous prefix and native policy after $failure ($enabled)", async (prior) => {
  const root = temporary.make("openclaw-systemd-rollback-");
  const env = {
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_SYSTEMD_UNIT: "openclaw-rollback",
  };
  const unit = path.join(root, ".config/systemd/user/openclaw-rollback.service");
  const environment = path.join(env.OPENCLAW_STATE_DIR, "gateway.systemd.env");
  const originals = new Map([
    [unit, "[Service]\nExecStart=/usr/bin/node /prefix-a/openclaw/dist/index.js gateway\n"],
    [environment, "OPERATOR=original\n"],
    [`${unit}.bak`, "older backup\n"],
  ]);
  for (const [file, contents] of originals) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, contents, { mode: 0o600 });
  }
  let enabled = prior.enabled;
  let running = prior.running;
  let failed = false;
  let current = true;
  const revoke = () => {
    current = false;
    assertGatewayServiceUpdateCurrent();
  };
  if (prior.failure === "availability-read") {
    native.available.mockImplementationOnce(async () => revoke());
  }
  if (prior.failure === "definition-read") {
    native.read.mockImplementationOnce(async () => {
      revoke();
      return null;
    });
  }
  native.active.mockImplementation(async () => ({ ok: true, value: running }));
  native.exec.mockImplementation(async (_env, args) => {
    let stdout = "";
    if (args[0] === "is-enabled") {
      if (prior.failure === "policy-read") {
        revoke();
      }
      stdout = enabled;
    }
    if (args[0] === "enable") {
      enabled = args.includes("--runtime") ? "enabled-runtime" : "enabled";
    }
    if (args[0] === "disable") {
      enabled = "disabled";
    }
    if (args[0] === "stop") {
      running = false;
    }
    if (args[0] === "restart") {
      if (!failed) {
        expect(await fs.readFile(unit, "utf8")).toContain("/prefix-b/");
        running = false;
        failed = true;
        return { code: 1, termination: "exit", stdout: "", stderr: "candidate failed" };
      }
      expect(await fs.readFile(unit, "utf8")).toBe(originals.get(unit));
      running = true;
    }
    return { code: 0, termination: "exit", stdout, stderr: "" };
  });
  const installation = withGatewayServiceUpdateAuthority(
    () => {
      if (!current) {
        throw new Error("Doctor custody revoked during service preparation");
      }
    },
    () =>
      installSystemdService({
        env,
        stdout: new PassThrough(),
        programArguments: ["/usr/bin/node", "/prefix-b/openclaw/dist/index.js", "gateway"],
        environment: { SERVICE_VALUE: "candidate" },
        environmentValueSources: { SERVICE_VALUE: "file" },
      }),
    { updateOwned: false, assertRecoveryCurrent: () => {} },
  );
  if (prior.failure === "activation") {
    await expect(installation).rejects.toThrow("candidate failed");
  } else {
    await expect(installation).rejects.toMatchObject({
      code: "service-authority-revoked",
      outcome: "unchanged",
    });
    expect(native.exec.mock.calls.every(([, args]) => args[0] === "is-enabled")).toBe(true);
  }
  for (const [file, contents] of originals) {
    expect(await fs.readFile(file, "utf8")).toBe(contents);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  }
  expect({ enabled, running }).toEqual({ enabled: prior.enabled, running: prior.running });
});
