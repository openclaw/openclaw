// Foreign-job tests protect the live command evidence and Doctor's removal boundary.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { execLaunchctl } from "./launchd-exec.js";
import {
  findForeignLaunchdJobs,
  repairForeignLaunchdJob,
  type ForeignLaunchdJob,
} from "./launchd-foreign-jobs.js";

vi.mock("./launchd-exec.js", async (original) => ({
  ...(await original<typeof import("./launchd-exec.js")>()),
  execLaunchctl: vi.fn(),
}));

const exec = vi.mocked(execLaunchctl);
const label = "ai.openclaw.update-validator.20260727.v2";
const uid = process.getuid?.() ?? 0;
const domain = `gui/${uid}`;
const target = `${domain}/${label}`;
const cli = "/opt/bin/openclaw";
const entry = "/opt/openclaw.mjs";
const restartCommand = "/usr/local/bin/openclaw gateway restart";
const shellScript = (...lines: string[]) => `#!/bin/sh\n${lines.join("\n")}\n`;
const restartScript = shellScript(
  "openclaw_bin=/usr/local/bin/openclaw",
  '"$openclaw_bin" gateway restart',
);
const pollingScript = (shebang: string) =>
  restartScript.replace("#!/bin/sh", shebang) +
  'for attempt in 1 2; do\n  "$openclaw_bin" gateway status\n  sleep 1\ndone\n';
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", termination: "exit" as const });
const missing = { ...ok(), code: 113, stderr: "Could not find service" };
const temporary = useAutoCleanupTempDirTracker(afterEach);
const shellEnvironmentNames = `SHELLOPTS BASHOPTS BASH_ENV ENV ZDOTDIR POSIXLY_CORRECT
IFS CDPATH PS4 BASH_XTRACEFD BASH_CUSTOM BASH_FUNC_example%%`.split(/\s+/);
let dir: string;
let jobs: Map<string, string>;
const operations = (...names: string[]) =>
  exec.mock.calls.filter(([args]) => names.includes(args[0] ?? "")).map(([args]) => args);

function addJob(name: string, args: string[], extra = "") {
  jobs.set(
    name,
    `${domain}/${name} = {\n\tpath = (submitted by launchctl[123])\n\ttype = Submitted\n\tprogram = ${args[0]}\n\targuments = {\n${args.map((arg) => `\t\t${arg}`).join("\n")}\n\t}\n\tproperties = keepalive | inferred program\n${extra}}\n`,
  );
}

function jobEnvironment(values: Record<string, string>, block = "environment") {
  return `\t${block} = {\n${Object.entries(values)
    .map(([key, value]) => `\t\t${key} => ${value}\n`)
    .join("")}\t}\n`;
}

async function addScript(contents: string, name = "validator.sh") {
  const file = path.join(dir, name);
  await fs.writeFile(file, contents);
  return file;
}

async function expectActions(gatewayActions: string[], extra: Partial<ForeignLaunchdJob> = {}) {
  expect(await findForeignLaunchdJobs({})).toEqual([
    expect.objectContaining({ gatewayActions, safeToRemove: gatewayActions.length > 0, ...extra }),
  ]);
}

async function expectShellEnvironmentBlocked(message?: string) {
  expect((await findForeignLaunchdJobs({}))[0], message).toMatchObject({
    gatewayActions: [],
    safeToRemove: false,
    diagnostic: "Shell environment alters execution; left unchanged.",
  });
}

async function addLifecycleJob(action = "restart", plist: boolean | "agent" = false) {
  addJob(label, [cli, "gateway", action]);
  if (plist) {
    const file = await addScript("<plist><dict></dict></plist>", "foreign.plist");
    jobs.set(label, jobs.get(label)!.replace("(submitted by launchctl[123])", file));
    if (plist === "agent") {
      jobs.set(label, jobs.get(label)!.replace("type = Submitted", "type = LaunchAgent"));
    }
  }
  return expectDefined((await findForeignLaunchdJobs({}))[0], "detected foreign job");
}

beforeEach(() => {
  vi.stubGlobal(
    "process",
    Object.create(process, {
      platform: { value: "darwin" },
      getuid: { value: () => uid },
    }),
  );
  dir = temporary.make("openclaw-foreign-jobs-");
  jobs = new Map();
  exec.mockReset();
  exec.mockImplementation(async (args) => {
    if (args[0] === "list") {
      return ok([...jobs.keys()].map((name) => `123\t0\t${name}`).join("\n"));
    }
    const name = args[1]?.slice(`${domain}/`.length) ?? "";
    if (args[0] === "print") {
      return jobs.has(name) ? ok(jobs.get(name)) : missing;
    }
    if (args[0] === "bootout") {
      jobs.delete(name);
      return ok();
    }
    if (args[0] === "disable") {
      return ok();
    }
    throw new Error(`Unexpected launchctl operation ${args[0]}`);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("foreign launchd command classification", () => {
  it.each([
    ["upgrade-2026-9-1-beta-1", [cli, "update", "--yes"], []],
    ["maintenance", ["/usr/bin/env", "PATH=/bin", cli, "gateway", "stop"], ["stop"]],
    ["profile-watch", ["/bin/node", entry, "--profile", "work", "gateway", "start"], ["start"]],
    ["echo", ["/bin/echo", "openclaw", "gateway", "restart"], []],
    ["inline-absolute", ["/bin/sh", "-c", restartCommand], ["restart"]],
    ["shell-syntax-check", ["/bin/sh", "-nc", "openclaw gateway restart"], []],
    ["node-bare-runtime", ["node", entry, "gateway", "restart"], []],
    ["bun-relative-entry", ["/opt/bin/bun", "./openclaw.mjs", "gateway", "restart"], []],
    ["env-bare-node", ["/usr/bin/env", "node", entry, "gateway", "restart"], []],
    ["help-short", [cli, "gateway", "restart", "-h"], []],
  ])("classifies %s lifecycle arguments", async (suffix, args, actions) => {
    const name = `ai.openclaw.${suffix}`;
    addJob(name, args);
    await expectActions(actions, { label: name, program: args[0], keepAlive: true });
  });

  it.each<[string, string[], string[]?]>([
    [restartScript.replace("/usr/local/bin/openclaw", "openclaw"), []],
    [restartScript, ["restart"]],
    [restartScript.replace("openclaw\n", "openclaw\u2028\n"), []],
    [restartScript.replaceAll("\n", "\r\n"), []],
    [shellScript("/opt/bin/openclaw gateway stop", "/opt/bin/openclaw gateway start"), ["stop"]],
    [shellScript("cat <<EOF", "openclaw gateway restart", "EOF"), []],
    [pollingScript("#!/usr/bin/env zsh"), ["restart"], ["$SCRIPT"]],
    [pollingScript(""), [], ["$SCRIPT"]],
    [pollingScript("#!/bin/bash -n"), [], ["$SCRIPT"]],
    [shellScript("sleep 120"), [], ["/bin/sh", "$SCRIPT", "-c", "openclaw gateway restart"]],
    [shellScript("sleep 120"), [], ["/bin/sh", "--", "$SCRIPT", "-c", "openclaw gateway restart"]],
  ])("classifies script %# without executing it", async (script, actions, argv) => {
    const file = await addScript(script);
    const args = (argv ?? ["/bin/sh", "$SCRIPT"]).map((arg) => (arg === "$SCRIPT" ? file : arg));
    addJob(label, args);
    await expectActions(actions, { program: args[0] });
  });

  it("protects managed, profile, custom, node and unrelated labels", async () => {
    const protectedLabels = [
      ...["gateway", "work", "custom", "node"].map((name) => `ai.openclaw.${name}`),
      "com.example.validator",
    ];
    for (const name of protectedLabels) {
      addJob(name, [cli, "gateway", "restart"]);
    }
    const env = { OPENCLAW_PROFILE: "work", OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.custom" };
    expect(await findForeignLaunchdJobs(env)).toEqual([]);
    for (const name of protectedLabels) {
      expect(
        (await repairForeignLaunchdJob({ label: name } as ForeignLaunchdJob, env)).removed,
      ).toBe(false);
    }
    expect(exec.mock.calls.map(([args]) => args)).toEqual([["list"]]);
  });

  it.each(["inline", "direct"])("guards %s shell environment names, not values", async (mode) => {
    const file = await addScript(`#!/bin/bash\nset -x\n${restartCommand}\n`);
    const args = mode === "inline" ? ["/bin/bash", "-xc", restartCommand] : [file];
    for (const block of ["inherited environment", "default environment"]) {
      addJob(
        label,
        args,
        jobEnvironment({ BASH_ENV: "/tmp/profile" }, block) +
          jobEnvironment({ PATH: "/usr/bin:/bin" }),
      );
      await expectShellEnvironmentBlocked(block);
    }
    for (const name of shellEnvironmentNames) {
      addJob(label, args, jobEnvironment({ [name]: name === "SHELLOPTS" ? "noexec" : "ignored" }));
      await expectShellEnvironmentBlocked(name);
    }
    addJob(
      label,
      args,
      jobEnvironment({
        PATH: "/usr/bin:/bin",
        HOME: "/home/operator",
        OPENCLAW_EXAMPLE: "SHELLOPTS=noexec BASH_ENV=ignored",
      }),
    );
    await expectActions(["restart"]);
  });

  it.each([
    { name: "node", viaEnv: true },
    { name: "env", viaEnv: false },
  ])("guards shell scripts named $name (env: $viaEnv)", async ({ name, viaEnv }) => {
    const file = await addScript(`#!/bin/bash\n${restartCommand}\n`, name);
    const prefix = name === "env" ? [file, "/usr/local/bin/openclaw"] : [file, entry];
    addJob(
      label,
      [...(viaEnv ? ["/usr/bin/env"] : []), ...prefix, "gateway", "restart"],
      jobEnvironment({ SHELLOPTS: "noexec" }),
    );
    await expectShellEnvironmentBlocked();
  });

  it("protects corrupted generated services from other profiles", async () => {
    addJob(label, [
      "/bin/sh",
      `/home/operator/.openclaw/service-env/${label}-env-wrapper.sh`,
      "env",
      "openclaw",
      "gateway",
      "restart",
    ]);
    expect(await findForeignLaunchdJobs({})).toEqual([]);
  });

  it("leaves oversized and symlinked shell scripts unverified", async () => {
    const file = await addScript(`openclaw gateway restart\n${"#".repeat(65536)}`);
    addJob(label, ["/bin/sh", file]);
    expect((await findForeignLaunchdJobs({}))[0]).toMatchObject({ safeToRemove: false });
    const link = path.join(dir, "link.sh");
    await fs.symlink(file, link);
    addJob(label, ["/bin/sh", link]);
    expect((await findForeignLaunchdJobs({}))[0]).toMatchObject({ safeToRemove: false });
  });
});

describe("foreign launchd repair", () => {
  it.each([false, "agent"] as const)("removes a verified job (plist: %s)", async (plist) => {
    const job = await addLifecycleJob(plist ? "stop" : "restart", plist);
    const result = await repairForeignLaunchdJob(job, {});
    expect(result).toEqual({
      removed: true,
      detail: expect.stringContaining(`Removed stray launchd job ${label}`),
    });
    expect(jobs.has(label)).toBe(false);
    if (plist) {
      expect(await fs.readFile(path.join(dir, "foreign.plist"), "utf8")).toContain("<plist>");
    }
    expect(operations("disable", "bootout")).toEqual(
      (plist ? ["disable", "bootout"] : ["bootout"]).map((action) => [action, target]),
    );
  });

  it("never trusts stale or caller-forged removal evidence", async () => {
    const job = await addLifecycleJob();
    addJob(label, ["/bin/echo", "gateway restart"]);
    expect((await repairForeignLaunchdJob(job, {})).removed).toBe(false);
    expect(operations("bootout", "disable")).toEqual([]);
  });

  it("does not claim success when launchd rejects removal", async () => {
    const job = await addLifecycleJob();
    const execute = exec.getMockImplementation()!;
    exec.mockImplementation(async (args, timeout) =>
      args[0] === "bootout"
        ? { ...missing, stderr: "Operation not permitted" }
        : execute(args, timeout),
    );
    expect((await repairForeignLaunchdJob(job, {})).removed).toBe(false);
    expect(jobs.has(label)).toBe(true);
  });

  it("revalidates a plist job after disabling it before bootout", async () => {
    const job = await addLifecycleJob("restart", true);
    const execute = exec.getMockImplementation()!;
    exec.mockImplementation(async (args, timeout) => {
      if (args[0] === "disable") {
        addJob(label, ["/bin/echo", "unrelated"]);
      }
      return execute(args, timeout);
    });
    expect(await repairForeignLaunchdJob(job, {})).toMatchObject({
      removed: false,
      detail: expect.stringContaining("definition changed before removal"),
    });
    expect(operations("bootout")).toEqual([]);
  });
});
