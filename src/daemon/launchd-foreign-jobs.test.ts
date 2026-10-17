// Foreign-job tests protect the live command evidence and Doctor's removal boundary.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", termination: "exit" as const });
const missing = {
  code: 113,
  stdout: "",
  stderr: "Could not find service",
  termination: "exit" as const,
};
let dir: string;
let jobs: Map<string, string>;

function addJob(name: string, args: string[], extra = "") {
  jobs.set(
    name,
    `${domain}/${name} = {\n\tpath = (submitted by launchctl[123])\n\ttype = Submitted\n\tprogram = ${args[0]}\n\targuments = {\n${args.map((arg) => `\t\t${arg}`).join("\n")}\n\t}\n\tproperties = keepalive | inferred program\n${extra}}\n`,
  );
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
  addJob(label, ["/opt/bin/openclaw", "gateway", action]);
  if (plist) {
    const file = await addScript("<plist><dict></dict></plist>", "foreign.plist");
    jobs.set(label, jobs.get(label)!.replace("(submitted by launchctl[123])", file));
    if (plist === "agent") {
      jobs.set(label, jobs.get(label)!.replace("type = Submitted", "type = LaunchAgent"));
    }
  }
  return expectDefined((await findForeignLaunchdJobs({}))[0], "detected foreign job");
}

beforeEach(async () => {
  vi.stubGlobal(
    "process",
    Object.create(process, {
      platform: { value: "darwin" },
      getuid: { value: () => uid },
    }),
  );
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-foreign-jobs-"));
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

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("foreign launchd command classification", () => {
  it.each([
    ["upgrade-2026-9-1-beta-1", ["/opt/bin/openclaw", "update", "--yes"], []],
    [
      "maintenance",
      ["/usr/bin/env", "PATH=/bin", "/opt/bin/openclaw", "gateway", "stop"],
      ["stop"],
    ],
    [
      "profile-watch",
      ["/bin/node", "/opt/openclaw.mjs", "--profile", "work", "gateway", "start"],
      ["start"],
    ],
    ["echo", ["/bin/echo", "openclaw", "gateway", "restart"], []],
    ["inline-absolute", ["/bin/sh", "-c", "/usr/local/bin/openclaw gateway restart"], ["restart"]],
    ["node-bare-runtime", ["node", "/opt/openclaw.mjs", "gateway", "restart"], []],
    ["bun-relative-entry", ["/opt/bin/bun", "./openclaw.mjs", "gateway", "restart"], []],
    ["env-bare-node", ["/usr/bin/env", "node", "/opt/openclaw.mjs", "gateway", "restart"], []],
    ["help-short", ["/opt/bin/openclaw", "gateway", "restart", "-h"], []],
  ])(
    "reports %s and verifies only executable lifecycle arguments",
    async (suffix, args, actions) => {
      const name = `ai.openclaw.${suffix}`;
      addJob(name, args);
      await expectActions(actions, { label: name, program: args[0], keepAlive: true });
    },
  );

  it.each([
    ['#!/bin/sh\nopenclaw_bin=openclaw\n"$openclaw_bin" gateway restart\n', []],
    [
      '#!/bin/sh\nopenclaw_bin=/usr/local/bin/openclaw\n"$openclaw_bin" gateway restart\n',
      ["restart"],
    ],
    [
      '#!/bin/sh\nopenclaw_bin=/usr/local/bin/openclaw\u2028\n"$openclaw_bin" gateway restart\n',
      [],
    ],
    [
      '#!/bin/sh\r\nopenclaw_bin=/usr/local/bin/openclaw\r\n"$openclaw_bin" gateway restart\r\n',
      [],
    ],
    ["#!/bin/sh\n/opt/bin/openclaw gateway stop\n/opt/bin/openclaw gateway start\n", ["stop"]],
    ["#!/bin/sh\ncat <<EOF\nopenclaw gateway restart\nEOF\n", []],
  ])(
    "reads shell scripts without executing or confusing quoted data with commands (%#)",
    async (script, actions) => {
      addJob(label, ["/bin/sh", await addScript(script)]);
      await expectActions(actions);
    },
  );

  it("does not inspect or remove managed, profile, custom, node, or unrelated labels", async () => {
    const protectedLabels = [
      "ai.openclaw.gateway",
      "ai.openclaw.work",
      "ai.openclaw.custom",
      "ai.openclaw.node",
      "com.example.validator",
    ];
    for (const name of protectedLabels) {
      addJob(name, ["/opt/bin/openclaw", "gateway", "restart"]);
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

  it.each(["inline", "direct"] as const)(
    "rejects shell-altering environment names for %s launches without examining values",
    async (mode) => {
      const file = await addScript(
        "#!/bin/bash\nset -x\n/usr/local/bin/openclaw gateway restart\n",
      );
      const args =
        mode === "inline"
          ? ["/bin/bash", "-xc", "/usr/local/bin/openclaw gateway restart"]
          : [file];
      for (const block of ["inherited environment", "default environment"]) {
        addJob(
          label,
          args,
          `\t${block} = {\n\t\tBASH_ENV => /tmp/profile\n\t}\n\tenvironment = {\n\t\tPATH => /usr/bin:/bin\n\t}\n`,
        );
        await expectShellEnvironmentBlocked(block);
      }
      for (const name of [
        "SHELLOPTS",
        "BASHOPTS",
        "BASH_ENV",
        "ENV",
        "ZDOTDIR",
        "POSIXLY_CORRECT",
        "IFS",
        "CDPATH",
        "PS4",
        "BASH_XTRACEFD",
        "BASH_CUSTOM",
        "BASH_FUNC_example%%",
      ]) {
        addJob(
          label,
          args,
          `\tenvironment = {\n\t\t${name} => ${name === "SHELLOPTS" ? "noexec" : "ignored"}\n\t}\n`,
        );
        await expectShellEnvironmentBlocked(name);
      }
      addJob(
        label,
        args,
        "\tenvironment = {\n\t\tPATH => /usr/bin:/bin\n\t\tHOME => /home/operator\n\t\tOPENCLAW_EXAMPLE => SHELLOPTS=noexec BASH_ENV=ignored\n\t}\n",
      );
      await expectActions(["restart"]);
    },
  );

  it.each([
    { name: "node", viaEnv: true },
    { name: "env", viaEnv: false },
  ])(
    "guards an executed shell script even when its filename is $name (env: $viaEnv)",
    async ({ name, viaEnv }) => {
      const file = await addScript("#!/bin/bash\n/usr/local/bin/openclaw gateway restart\n", name);
      const prefix =
        name === "env" ? [file, "/usr/local/bin/openclaw"] : [file, "/opt/openclaw.mjs"];
      addJob(
        label,
        [...(viaEnv ? ["/usr/bin/env"] : []), ...prefix, "gateway", "restart"],
        "\tenvironment = {\n\t\tSHELLOPTS => noexec\n\t}\n",
      );
      await expectShellEnvironmentBlocked();
    },
  );

  it.each([
    { shebang: "#!/usr/bin/env zsh", verified: true },
    { shebang: "", verified: false },
    { shebang: "#!/bin/bash -n", verified: false },
  ])(
    "verifies directly executed scripts only with an executing shell shebang ($shebang)",
    async ({ shebang, verified }) => {
      const file = await addScript(
        `${shebang}\nopenclaw_bin=/usr/local/bin/openclaw\n"$openclaw_bin" gateway restart\nfor attempt in 1 2; do\n  "$openclaw_bin" gateway status\n  sleep 1\ndone\n`,
      );
      addJob(label, [file]);
      await expectActions(verified ? ["restart"] : [], { program: file });
    },
  );

  it("protects another profile's generated service even if its command is corrupted", async () => {
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

  it("does not remove shell syntax-check jobs", async () => {
    addJob(label, ["/bin/sh", "-nc", "openclaw gateway restart"]);
    expect((await findForeignLaunchdJobs({}))[0]).toMatchObject({ safeToRemove: false });
  });

  it.each([{ prefix: [] }, { prefix: ["--"] }])(
    "does not treat script positional arguments as shell options ($prefix)",
    async ({ prefix }) => {
      const file = await addScript("#!/bin/sh\nsleep 120\n", "harmless.sh");
      addJob(label, ["/bin/sh", ...prefix, file, "-c", "openclaw gateway restart"]);
      expect((await findForeignLaunchdJobs({}))[0]).toMatchObject({ safeToRemove: false });
    },
  );

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
  it("revalidates the live command, removes a submitted lifecycle job and confirms absence", async () => {
    const job = await addLifecycleJob();
    const result = await repairForeignLaunchdJob(job, {});
    expect(result).toEqual({
      removed: true,
      detail: expect.stringContaining(`Removed stray launchd job ${label}`),
    });
    expect(jobs.has(label)).toBe(false);
    expect(exec.mock.calls.filter(([args]) => args[0] === "disable")).toEqual([]);
  });

  it("never trusts stale or caller-forged removal evidence", async () => {
    const job = await addLifecycleJob();
    addJob(label, ["/bin/echo", "gateway restart"]);
    expect((await repairForeignLaunchdJob(job, {})).removed).toBe(false);
    expect(exec.mock.calls.some(([args]) => ["bootout", "disable"].includes(args[0] ?? ""))).toBe(
      false,
    );
  });

  it("disables a verified foreign plist job at login while retaining its file", async () => {
    const job = await addLifecycleJob("stop", "agent");
    expect((await repairForeignLaunchdJob(job, {})).removed).toBe(true);
    expect(await fs.readFile(path.join(dir, "foreign.plist"), "utf8")).toContain("<plist>");
    expect(
      exec.mock.calls
        .filter(([args]) => ["disable", "bootout"].includes(args[0] ?? ""))
        .map(([args]) => args),
    ).toEqual([
      ["disable", `${domain}/${label}`],
      ["bootout", `${domain}/${label}`],
    ]);
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
    expect(exec.mock.calls.some(([args]) => args[0] === "bootout")).toBe(false);
  });
});
