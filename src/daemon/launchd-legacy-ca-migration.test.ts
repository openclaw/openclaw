import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as durability from "../infra/directory-durability.js";
import * as exec from "../process/exec.js";
import { PROXY_FIXTURE_CERTIFICATE } from "../test-helpers/proxy-tls-fixture.js";
import { stageLaunchAgent } from "./launchd-install.js";
import { buildLaunchAgentPlist, readLaunchAgentProgramArgumentsFromFile } from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import {
  resolveLaunchAgentEnvFilePath,
  resolveLaunchAgentEnvironmentReadOptions,
  resolveLaunchAgentPlistPath,
} from "./launchd-service-files.js";
import { GatewayServiceAuthorityError } from "./service-update-authority.js";

const native = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("./exec-file.js", async (original) => ({
  ...(await original<typeof import("./exec-file.js")>()),
  execFileUtf8: native.exec,
}));
vi.mock("./launchd-system.js", async (original) => ({
  ...(await original<typeof import("./launchd-system.js")>()),
  assertNoSystemLaunchDaemonOwnership: vi.fn().mockResolvedValue(undefined),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const legacyPath = "/etc/ssl/cert.pem";
const privatePem = `${PROXY_FIXTURE_CERTIFICATE}\n`;
const stock = gunzipSync(
  await fs.readFile(new URL("./fixtures/legacy-ca/openbsd-1.22.2.1.pem.gz", import.meta.url)),
);
const programArguments = ["/usr/local/bin/node", "/opt/openclaw/openclaw.mjs", "gateway"];
let legacy = Buffer.alloc(0);
let legacyFailure: Error | undefined;
beforeEach(() => {
  legacy = Buffer.concat([stock, Buffer.from(privatePem)]);
  legacyFailure = undefined;
  const readFile = fs.readFile;
  vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
    if (args[0] === legacyPath) {
      if (legacyFailure) {
        throw legacyFailure;
      }
      return args[1] === "utf8" ? legacy.toString("utf8") : legacy;
    }
    return readFile(...args);
  });
  vi.spyOn(exec, "runExec").mockImplementation(async (file, args, options) => {
    if (file !== "/usr/bin/plutil" || typeof options !== "object" || !options.input) {
      throw new Error(`Unexpected native command: ${file}`);
    }
    return decodeLaunchAgentPlistFixture(options.input, args[1]);
  });
  native.exec.mockReset().mockImplementation(async (_command, args: string[]) => ({
    code: 0,
    termination: "exit",
    stderr: "",
    stdout: JSON.stringify(
      args.includes("trust-settings")
        ? {
            domains: [0, 1, 2].map((domain) => ({
              domain,
              exportStatus: 0,
              exportVersion: 1,
              records: [],
              certificatesStatus: -25263,
              certificateDERBase64: null,
            })),
          }
        : {
            createStatus: 0,
            networkStatus: 0,
            certificateCount: "1",
            ok: false,
            errorCode: -67843,
            result: {
              TrustResultValue: 5,
              TrustResultDetails: [{ StatusCodes: [-2147409622], AnchorTrusted: false }],
            },
          },
    ),
  }));
});
afterEach(() => vi.restoreAllMocks());

async function installedFixture(installedCa = legacyPath) {
  const home = dirs.make("launchd-ca-migration-");
  const label = "ai.openclaw.ca-migration-test";
  const env = {
    HOME: home,
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    OPENCLAW_LAUNCHD_LABEL: label,
  };
  const plistPath = resolveLaunchAgentPlistPath(env);
  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.writeFile(
    plistPath,
    buildLaunchAgentPlist({
      label,
      programArguments,
      stdoutPath: "/dev/null",
      stderrPath: "/dev/null",
      environment: {
        NODE_EXTRA_CA_CERTS: installedCa,
        PATH: "/operator/bin:/usr/bin",
        FIXTURE: "retained",
      },
    }),
  );
  const warnings: string[] = [];
  const args = {
    env,
    programArguments,
    stdout: new PassThrough(),
    warn: (message: string) => warnings.push(message),
    environment: {
      NODE_USE_SYSTEM_CA: "1",
      PATH: "/operator/bin:/usr/bin",
      FIXTURE: "retained",
    } as Record<string, string>,
  };
  const read = () =>
    readLaunchAgentProgramArgumentsFromFile(plistPath, {
      ...resolveLaunchAgentEnvironmentReadOptions(env, label),
      requireEffective: true,
    });
  return { env, label, args, warnings, read };
}

it("migrates a service-owned proven addition before publishing its replacement environment", async () => {
  const fixture = await installedFixture();
  const original = Buffer.from(legacy);
  await stageLaunchAgent(fixture.args);
  const command = await fixture.read();
  const maintainedPath = path.join(
    fixture.env.OPENCLAW_STATE_DIR,
    "service-ca",
    `${fixture.label}-operator-ca.pem`,
  );
  expect(command).toMatchObject({
    programArguments,
    environment: {
      NODE_EXTRA_CA_CERTS: maintainedPath,
      NODE_USE_SYSTEM_CA: "1",
      PATH: "/operator/bin:/usr/bin",
      FIXTURE: "retained",
    },
  });
  expect(await fs.readFile(maintainedPath, "utf8")).toBe(privatePem);
  expect((await fs.stat(maintainedPath)).mode & 0o777).toBe(0o600);
  expect(legacy).toEqual(original);
  expect(fixture.warnings.join("\n")).toContain("migrated");
  await fs.writeFile(maintainedPath, `${privatePem}\n# operator rotation\n`);
  await stageLaunchAgent(fixture.args);
  expect((await fixture.read())?.environment?.NODE_EXTRA_CA_CERTS).toBe(maintainedPath);
  expect(await fs.readFile(maintainedPath, "utf8")).toContain("# operator rotation");
});

it("preserves the installed distinct operator bundle unless the installer explicitly selects another", async () => {
  const fixture = await installedFixture("/operator/service.pem");
  await stageLaunchAgent(fixture.args);
  expect((await fixture.read())?.environment?.NODE_EXTRA_CA_CERTS).toBe("/operator/service.pem");
  fixture.args.environment.NODE_EXTRA_CA_CERTS = "/operator/replacement.pem";
  await stageLaunchAgent(fixture.args);
  expect((await fixture.read())?.environment?.NODE_EXTRA_CA_CERTS).toBe(
    "/operator/replacement.pem",
  );
  expect(native.exec).not.toHaveBeenCalled();
});

it("excludes stock keys and known incident cross-signs while retaining proven private additions", async () => {
  const incident = await fs.readFile(
    new URL("../secrets/egress-proxy/fixtures/emudhra/untrusted.pem", import.meta.url),
  );
  legacy = Buffer.concat([
    stock,
    incident,
    stock.subarray(
      stock.indexOf("-----BEGIN CERTIFICATE-----"),
      stock.indexOf("-----END CERTIFICATE-----") + "-----END CERTIFICATE-----".length,
    ),
    Buffer.from(`\n${privatePem}`),
  ]);
  const fixture = await installedFixture();
  await stageLaunchAgent(fixture.args);
  const output = (await fixture.read())?.environment?.NODE_EXTRA_CA_CERTS;
  expect(output).toBeTruthy();
  expect(await fs.readFile(output!, "utf8")).toBe(privatePem);
  expect(fixture.warnings.join("\n")).toContain("excluded");
});

it.each([
  "stock-only",
  "changed-prefix",
  "malformed",
  "unreadable",
  "native-unavailable",
  "destination-conflict",
])(
  "continues hardening with actionable %s guidance instead of restoring the legacy bundle",
  async (failure) => {
    const fixture = await installedFixture();
    const maintainedPath = path.join(
      fixture.env.OPENCLAW_STATE_DIR,
      "service-ca",
      `${fixture.label}-operator-ca.pem`,
    );
    if (failure === "stock-only") {
      legacy = stock;
    }
    if (failure === "changed-prefix") {
      legacy = Buffer.concat([Buffer.from("# changed\n"), legacy]);
    }
    if (failure === "malformed") {
      legacy = Buffer.concat([
        stock,
        Buffer.from("-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----\n"),
      ]);
    }
    if (failure === "unreadable") {
      legacyFailure = Object.assign(new Error("unreadable legacy input"), { code: "EACCES" });
    }
    if (failure === "native-unavailable") {
      native.exec.mockResolvedValue({
        code: 1,
        termination: "error",
        stdout: "",
        stderr: "unavailable",
      });
    }
    if (failure === "destination-conflict") {
      await fs.mkdir(path.dirname(maintainedPath), { recursive: true });
      await fs.writeFile(maintainedPath, "existing operator file", { mode: 0o640 });
    }
    await stageLaunchAgent(fixture.args);
    expect((await fixture.read())?.environment).toMatchObject({
      NODE_USE_SYSTEM_CA: "1",
      FIXTURE: "retained",
    });
    expect((await fixture.read())?.environment?.NODE_EXTRA_CA_CERTS).toBeUndefined();
    const message = fixture.warnings.join("\n");
    expect(message).toContain(failure === "stock-only" ? "unnecessary" : "migration");
    expect(message).toContain(failure === "stock-only" ? "stock" : "NODE_EXTRA_CA_CERTS");
    if (failure === "destination-conflict") {
      expect(await fs.readFile(maintainedPath, "utf8")).toBe("existing operator file");
      expect((await fs.stat(maintainedPath)).mode & 0o777).toBe(0o640);
    }
  },
);

it.each([
  {
    name: "alternate certificate",
    original: "deny-root1.pem",
    alternate: "deny-root2.pem",
    unresolved: false,
  },
  {
    name: "alternate EC encoding",
    original: "ec-named-root.pem",
    alternate: "ec-explicit-root.pem",
    unresolved: false,
  },
  {
    name: "unresolved deny",
    original: "deny-root1.pem",
    alternate: "deny-root2.pem",
    unresolved: true,
  },
])(
  "never imports an explicitly distrusted key ($name)",
  async ({ original, alternate: alternateFile, unresolved }) => {
    const certificate = new X509Certificate(
      await fs.readFile(new URL(`./fixtures/legacy-ca/${original}`, import.meta.url)),
    );
    const alternate = await fs.readFile(
      new URL(`./fixtures/legacy-ca/${alternateFile}`, import.meta.url),
    );
    legacy = Buffer.concat([stock, alternate]);
    const fingerprint = createHash("sha1").update(certificate.raw).digest("hex");
    const ordinaryInspection = native.exec.getMockImplementation()!;
    native.exec.mockImplementation(async (command: string, args: string[]) =>
      args.includes("trust-settings")
        ? {
            code: 0,
            termination: "exit",
            stderr: "",
            stdout: JSON.stringify({
              domains: [0, 1, 2].map((domain) => ({
                domain,
                exportStatus: 0,
                exportVersion: 1,
                records:
                  domain === 1
                    ? [{ certificateSHA1: unresolved ? "00".repeat(20) : fingerprint, deny: true }]
                    : [],
                certificatesStatus: domain === 1 ? 0 : -25263,
                certificateDERBase64: domain === 1 ? [certificate.raw.toString("base64")] : null,
              })),
            }),
          }
        : ordinaryInspection(command, args),
    );
    const fixture = await installedFixture();
    await stageLaunchAgent(fixture.args);
    expect((await fixture.read())?.environment?.NODE_EXTRA_CA_CERTS).toBeUndefined();
    // Unsupported key encodings must refuse automatic trust as ambiguous. Node's
    // supported EC path additionally exercises same-key native Deny exclusion.
    expect(fixture.warnings.join("\n")).toMatch(unresolved ? /ambiguous/u : /excluded|ambiguous/u);
  },
);

it("propagates lost native authority rather than converting it into best-effort success", async () => {
  const fixture = await installedFixture();
  native.exec.mockRejectedValue(
    new GatewayServiceAuthorityError(new Error("synthetic lost authority")),
  );
  await expect(stageLaunchAgent(fixture.args)).rejects.toThrow("synthetic lost authority");
  expect((await fixture.read())?.environment?.NODE_EXTRA_CA_CERTS).toBe(legacyPath);
});

it("reuses a complete unreferenced bundle after interrupted service publication", async () => {
  const fixture = await installedFixture();
  const rename = fs.rename;
  const envFile = resolveLaunchAgentEnvFilePath(fixture.env, fixture.label);
  let interrupted = false;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === envFile && !interrupted) {
      interrupted = true;
      throw new Error("synthetic interrupted service publication");
    }
    return rename(from, to);
  });
  await expect(stageLaunchAgent(fixture.args)).rejects.toThrow(
    "synthetic interrupted service publication",
  );
  expect((await fixture.read())?.environment?.NODE_EXTRA_CA_CERTS).toBe(legacyPath);
  await stageLaunchAgent(fixture.args);
  const output = (await fixture.read())?.environment?.NODE_EXTRA_CA_CERTS;
  expect(output).toBeTruthy();
  expect(await fs.readFile(output!, "utf8")).toBe(privatePem);
});

it("requires durable publication again before referencing a complete orphan on retry", async () => {
  const fixture = await installedFixture();
  const maintainedPath = path.join(
    fixture.env.OPENCLAW_STATE_DIR,
    "service-ca",
    `${fixture.label}-operator-ca.pem`,
  );
  await fs.mkdir(path.dirname(maintainedPath), { recursive: true });
  await fs.writeFile(maintainedPath, privatePem, { mode: 0o600 });
  const sync = vi.spyOn(durability, "syncDirectory").mockResolvedValue({
    status: "unsupported",
    code: "ENOTSUP",
  });
  const rename = fs.rename;
  const envFile = resolveLaunchAgentEnvFilePath(fixture.env, fixture.label);
  vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
    if (to === envFile) {
      throw new Error("synthetic interrupted service publication");
    }
    return rename(from, to);
  });
  await expect(stageLaunchAgent(fixture.args)).rejects.toThrow(
    "synthetic interrupted service publication",
  );
  expect(fixture.warnings.join("\n")).toContain("CA migration failed while publishing");
  expect((await fixture.read())?.environment?.NODE_EXTRA_CA_CERTS).toBe(legacyPath);
  sync.mockRestore();
  await stageLaunchAgent(fixture.args);
  expect((await fixture.read())?.environment?.NODE_EXTRA_CA_CERTS).toBe(maintainedPath);
  expect(await fs.readFile(maintainedPath, "utf8")).toBe(privatePem);
});
