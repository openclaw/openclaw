import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertGatewayServiceUpdateCurrent,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";
import { withSystemdDefinitionMutation } from "./systemd-definition-mutation.js";
import { installSystemdService, stageSystemdService } from "./systemd-install.js";

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
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  native.exec.mockReset();
  native.active.mockReset();
  native.available.mockReset().mockResolvedValue(undefined);
  native.read.mockReset().mockResolvedValue(null);
});

async function createInstallFixture() {
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
  return { env, unit, environment, originals };
}

it.each([false, true])(
  "retains generated input referenced by a concurrent unit edit (replacement=%s)",
  async (replacement) => {
    const { env, unit, environment } = await createInstallFixture();
    await fs.rm(environment);
    const rename = fs.rename.bind(fs);
    let edited = false;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (destination === unit && !edited) {
        edited = true;
        const contents = `${await fs.readFile(unit, "utf8")}# concurrent edit\n`;
        const target = replacement ? `${unit}.operator` : unit;
        await fs.writeFile(target, contents, { mode: 0o600 });
        if (replacement) {
          await rename(target, unit);
        }
      }
    });

    await expect(
      stageSystemdService({
        env,
        stdout: new PassThrough(),
        programArguments: ["/usr/bin/node", "/prefix-b/openclaw/dist/index.js", "gateway"],
        environment: { SERVICE_VALUE: "candidate" },
        environmentValueSources: { SERVICE_VALUE: "file" },
      }),
    ).rejects.toThrow("changed during publication");
    expect(await fs.readFile(unit, "utf8")).toContain("# concurrent edit");
    expect(await fs.readFile(unit, "utf8")).toContain(environment);
    expect(await fs.readFile(environment, "utf8")).toContain("SERVICE_VALUE=candidate");
  },
);

it.each(["success", "failure", "interruption"] as const)(
  "keeps cached candidate inputs until rollback reload confirms restoration (%s)",
  async (reload) => {
    const { env, unit, environment, originals } = await createInstallFixture();
    await fs.rm(environment);
    let cachedUnit = originals.get(unit)!;
    let activationFailed = false;
    let restoredReload = false;
    let inputPresentAtReload = false;
    const warnings: string[] = [];
    native.active.mockResolvedValue({ ok: true, value: true });
    native.exec.mockImplementation(async (_env, args) => {
      if (args[0] === "daemon-reload") {
        const diskUnit = await fs.readFile(unit, "utf8");
        if (activationFailed) {
          expect(diskUnit).toBe(originals.get(unit));
          inputPresentAtReload = await fs.stat(environment).then(
            () => true,
            () => false,
          );
          if (reload !== "success") {
            return {
              code: 1,
              termination: reload === "failure" ? "exit" : "signal",
              stdout: "",
              stderr: `rollback reload ${reload}`,
            };
          }
          restoredReload = true;
        }
        cachedUnit = diskUnit;
      }
      if (args[0] === "restart" && !activationFailed) {
        expect(cachedUnit).toContain(environment);
        activationFailed = true;
        return { code: 1, termination: "exit", stdout: "", stderr: "candidate failed" };
      }
      return {
        code: 0,
        termination: "exit",
        stdout: args[0] === "is-enabled" ? "enabled" : "",
        stderr: "",
      };
    });
    const installation = installSystemdService({
      env,
      stdout: new PassThrough(),
      warn: (message) => warnings.push(message),
      programArguments: ["/usr/bin/node", "/prefix-b/openclaw/dist/index.js", "gateway"],
      environment: { SERVICE_VALUE: "candidate" },
      environmentValueSources: { SERVICE_VALUE: "file" },
    });
    await expect(installation).rejects.toThrow("candidate failed");
    expect(await fs.readFile(unit, "utf8")).toBe(originals.get(unit));
    expect(inputPresentAtReload).toBe(true);
    if (reload === "success") {
      expect(restoredReload).toBe(true);
      expect(cachedUnit).toBe(originals.get(unit));
      await expect(fs.stat(environment)).rejects.toMatchObject({ code: "ENOENT" });
      expect(warnings).toEqual([]);
    } else {
      expect(cachedUnit).toContain(environment);
      expect(await fs.readFile(environment, "utf8")).toContain("SERVICE_VALUE=candidate");
      expect(warnings.join("\n")).toContain("retained");
      expect(warnings.join("\n")).toContain(environment);
      expect(warnings.join("\n")).toContain("Retry");
    }
  },
);

it("retries a failed rollback reload before retiring retained generated inputs", async () => {
  const { env, unit, environment, originals } = await createInstallFixture();
  await fs.rm(environment);
  const warnings: string[] = [];
  await withSystemdDefinitionMutation(
    env,
    env,
    async (mutation) => {
      await mutation.publish(environment, "SERVICE_VALUE=candidate\n", 0o600);
      await mutation.publish(unit, `[Service]\nEnvironmentFile=${environment}\n`, 0o600);
      native.exec.mockResolvedValueOnce({
        code: 1,
        termination: "exit",
        stdout: "",
        stderr: "reload failed",
      });
      await expect(mutation.restoreAll()).rejects.toThrow("reload was not confirmed");
      expect(await fs.readFile(unit, "utf8")).toBe(originals.get(unit));
      expect(await fs.readFile(environment, "utf8")).toContain("SERVICE_VALUE=candidate");
      native.exec.mockImplementationOnce(async (_env, args) => {
        expect(args).toEqual(["daemon-reload"]);
        expect(await fs.readFile(unit, "utf8")).toBe(originals.get(unit));
        expect(await fs.readFile(environment, "utf8")).toContain("SERVICE_VALUE=candidate");
        return { code: 0, termination: "exit", stdout: "", stderr: "" };
      });
      await expect(mutation.restoreAll()).resolves.toBe(true);
      await expect(fs.stat(environment)).rejects.toMatchObject({ code: "ENOENT" });
    },
    { warn: (message) => warnings.push(message) },
  );
  expect(warnings).toHaveLength(1);
});

it.each([
  { enabled: "enabled", running: true, failure: "activation" },
  { enabled: "disabled", running: false, failure: "activation" },
  { enabled: "enabled-runtime", running: true, failure: "activation" },
  { enabled: "enabled", running: true, failure: "availability-read" },
  { enabled: "enabled", running: true, failure: "definition-read" },
  { enabled: "enabled", running: true, failure: "policy-read" },
])("preserves the previous prefix and native policy after $failure ($enabled)", async (prior) => {
  const { env, unit, originals } = await createInstallFixture();
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

it.each(["publication", "activation"])(
  "leaves %s interruption recovery to the definition transaction",
  async (failure) => {
    const { env, unit, environment, originals } = await createInstallFixture();
    let current = true;
    const revoke = () => {
      current = false;
      assertGatewayServiceUpdateCurrent();
    };
    native.exec.mockImplementation(async (_env, args) => {
      assertGatewayServiceUpdateCurrent();
      if (failure === "activation" && args[0] === "restart") {
        revoke();
      }
      return { code: 0, termination: "exit", stdout: "", stderr: "" };
    });
    const check = async () => {
      assertGatewayServiceUpdateCurrent();
    };
    const installation = withGatewayServiceUpdateAuthority(
      () => {
        if (!current) {
          throw new Error("Doctor custody revoked during transaction-owned installation");
        }
      },
      () =>
        installSystemdService({
          env,
          stdout: new PassThrough(),
          programArguments: ["/usr/bin/node", "/prefix-b/openclaw/dist/index.js", "gateway"],
          environment: { SERVICE_VALUE: "candidate" },
          environmentValueSources: { SERVICE_VALUE: "file" },
          definitionTransaction: {
            assertCurrent: assertGatewayServiceUpdateCurrent,
            beforeWrite: check,
            filePrepared: check,
            fileWritten: async (file) => {
              if (failure === "publication" && file === unit) {
                revoke();
              }
              await check();
            },
            taskPrepared: check,
            taskWritten: check,
          },
        }),
      { updateOwned: false, assertRecoveryCurrent: () => {} },
    );
    await expect(installation).rejects.toMatchObject({
      code: "service-authority-revoked",
      outcome: undefined,
    });
    // The central receipt owner must restore these together in its own order.
    expect(await fs.readFile(unit, "utf8")).toContain("/prefix-b/");
    expect(await fs.readFile(environment, "utf8")).toContain("SERVICE_VALUE=candidate");
    expect(await fs.readFile(`${unit}.bak`, "utf8")).toBe(originals.get(unit));
    expect(native.exec.mock.calls.map(([, args]) => args[0])).toEqual(
      failure === "publication" ? [] : ["daemon-reload", "enable", "restart"],
    );
  },
);
