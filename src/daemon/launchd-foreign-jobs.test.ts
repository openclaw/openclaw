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
    [
      "ai.openclaw.update-validator.20260727.v2",
      ["/opt/bin/openclaw", "gateway", "restart"],
      ["restart"],
    ],
    ["ai.openclaw.upgrade-2026-9-1-beta-1", ["/opt/bin/openclaw", "update", "--yes"], []],
    [
      "ai.openclaw.maintenance",
      ["/usr/bin/env", "PATH=/bin", "/opt/bin/openclaw", "gateway", "stop"],
      ["stop"],
    ],
    [
      "ai.openclaw.profile-watch",
      ["/bin/node", "/opt/openclaw.mjs", "--profile", "work", "gateway", "start"],
      ["start"],
    ],
    ["ai.openclaw.echo", ["/bin/echo", "openclaw", "gateway", "restart"], []],
    ["ai.openclaw.inline", ["/bin/sh", "-c", "openclaw gateway restart"], []],
    [
      "ai.openclaw.inline-absolute",
      ["/bin/sh", "-c", "/usr/local/bin/openclaw gateway restart"],
      ["restart"],
    ],
    ["ai.openclaw.bare", ["openclaw", "gateway", "restart"], []],
    ["ai.openclaw.env-bare", ["/usr/bin/env", "openclaw", "gateway", "restart"], []],
    ["ai.openclaw.node-bare-entry", ["/usr/bin/node", "openclaw.mjs", "gateway", "restart"], []],
    ["ai.openclaw.node-bare-runtime", ["node", "/opt/openclaw.mjs", "gateway", "restart"], []],
    ["ai.openclaw.bun", ["/opt/bin/bun", "/opt/openclaw.mjs", "gateway", "restart"], ["restart"]],
    [
      "ai.openclaw.bun-relative-entry",
      ["/opt/bin/bun", "./openclaw.mjs", "gateway", "restart"],
      [],
    ],
    [
      "ai.openclaw.env-node",
      ["/usr/bin/env", "/usr/bin/node", "/opt/openclaw.mjs", "gateway", "restart"],
      ["restart"],
    ],
    [
      "ai.openclaw.env-bare-node",
      ["/usr/bin/env", "node", "/opt/openclaw.mjs", "gateway", "restart"],
      [],
    ],
    ["ai.openclaw.help", ["/opt/bin/openclaw", "gateway", "restart", "--help"], []],
    ["ai.openclaw.help-short", ["/opt/bin/openclaw", "gateway", "restart", "-h"], []],
    ["ai.openclaw.exec", ["exec", "openclaw", "gateway", "restart"], []],
  ])("reports %s and verifies only executable lifecycle arguments", async (name, args, actions) => {
    addJob(name, args);
    const found = await findForeignLaunchdJobs({});
    expect(found).toEqual([
      expect.objectContaining({
        label: name,
        program: args[0],
        keepAlive: true,
        gatewayActions: actions,
        safeToRemove: actions.length > 0,
      }),
    ]);
  });

  it.each([
    ["#!/bin/sh\nopenclaw gateway restart\n", []],
    ["#!/bin/sh\n/usr/local/bin/openclaw gateway restart\n", ["restart"]],
    ['#!/bin/sh\nopenclaw_bin=openclaw\n"$openclaw_bin" gateway restart\n', []],
    ['#!/bin/sh\nopenclaw_bin="/opt/bin/openclaw"\n"$openclaw_bin" gateway restart\n', []],
    [
      "#!/bin/sh\nset -e\n'openclaw_bin=/opt/bin/openclaw'\n\"$openclaw_bin\" gateway restart\n",
      [],
    ],
    ["#!/bin/sh\n/opt/*/openclaw gateway restart\n", []],
    ["#!/bin/sh\n~/bin/openclaw gateway restart\n", []],
    [
      '#!/bin/sh\nopenclaw_bin=/usr/local/bin/openclaw\n"$openclaw_bin" gateway restart\n',
      ["restart"],
    ],
    [
      '#!/bin/sh\nopenclaw_bin=/usr/local/bin/openclaw\n"${openclaw_bin}" gateway restart\n',
      ["restart"],
    ],
    [
      "#!/bin/sh\nopenclaw_bin=/usr/local/bin/openclaw\n$openclaw_bin gateway restart\n",
      ["restart"],
    ],
    [
      "#!/bin/sh\nopenclaw_bin=/usr/local/bin/openclaw\n${openclaw_bin} gateway restart\n",
      ["restart"],
    ],
    ["#!/bin/sh\nexec /usr/local/bin/openclaw gateway restart --profile work\n", ["restart"]],
    ["#!/bin/sh\nopenclaw gateway restart --help\n", []],
    ['#!/bin/sh\n"openclaw" gateway restart\n', []],
    ['#!/bin/sh\nset "-e"\nopenclaw gateway restart\n', []],
    ['#!/bin/sh\nopenclaw_bin=/bin/echo\n"$openclaw_bin" gateway restart\n', []],
    ["#!/bin/sh\nopenclaw gateway restart\u2028", []],
    [
      '#!/bin/sh\nopenclaw_bin=/usr/local/bin/openclaw\u2028\n"$openclaw_bin" gateway restart\n',
      [],
    ],
    [
      '#!/bin/sh\r\nopenclaw_bin=/usr/local/bin/openclaw\r\n"$openclaw_bin" gateway restart\r\n',
      [],
    ],
    ["#!/bin/sh\nopenclaw gateway restart\n# carriage return\r", []],
    [
      '#!/bin/bash\nset -e\nUID=1000\nopenclaw_bin=/usr/local/bin/openclaw\n"$openclaw_bin" gateway restart\n',
      [],
    ],
    [
      '#!/bin/sh\nPATH=/usr/local/bin\nopenclaw_bin=/usr/local/bin/openclaw\n"$openclaw_bin" gateway restart\n',
      [],
    ],
    ["#!/bin/sh\nexport PATH=/usr/local/bin\nopenclaw gateway restart\n", []],
    [
      '#!/bin/sh\nexport OPENCLAW_BIN=/usr/local/bin/openclaw\n"$OPENCLAW_BIN" gateway restart\n',
      ["restart"],
    ],
    ["#!/bin/sh\nset -e -u -x +e +u +x\n/usr/local/bin/openclaw gateway restart\n", ["restart"]],
    ["#!/bin/sh\nset -eu\nopenclaw gateway restart\n", []],
    ["#!/bin/sh\nexec >/dev/null\nopenclaw gateway restart\n", []],
    ["#!/bin/sh\nUID=/usr/local/bin/openclaw gateway restart\n", []],
    ["#!/bin/sh\nenv PATH=/usr/local/bin openclaw gateway restart\n", []],
    [
      '#!/bin/sh\nset -u\nopenclaw_bin=/usr/local/bin/openclaw\n"$openclaw_bin" gateway restart --profile "$PROFILE"\nopenclaw gateway restart\n',
      [],
    ],
    [
      '#!/bin/sh\nset -u\nopenclaw_bin=/usr/local/bin/openclaw\n"$openclaw_bin" gateway restart --profile "${PROFILE}"\n',
      [],
    ],
    [
      '#!/bin/sh\nset -u\nopenclaw_bin=/usr/local/bin/openclaw\n"$openclaw_bin" gateway restart --profile work\n',
      ["restart"],
    ],
    ["#!/bin/sh\n/opt/bin/openclaw gateway stop\n/opt/bin/openclaw gateway start\n", ["stop"]],
    ['#!/bin/sh\n# openclaw gateway restart\necho "openclaw gateway start"\n', []],
    ["#!/bin/sh\ncat <<EOF\nopenclaw gateway restart\nEOF\n", []],
    ['#!/bin/sh\necho "example:\nopenclaw gateway restart\n"\n', []],
    ["#!/bin/sh\noc=\"/opt/bin/openclaw\"\n'$oc' gateway restart\n", []],
    ['#!/bin/sh\n"$unknown" gateway restart\n', []],
    ['#!/bin/sh\noc="/opt/bin/openclaw"\nunset oc\n"$oc" gateway restart\n', []],
    ["#!/bin/sh\ncleanup() {\nopenclaw gateway restart\n}\nsleep 30\n", []],
    ["#!/bin/sh\nif false; then\nopenclaw gateway restart\nfi\n", []],
    ["#!/bin/sh\nexit 0\nopenclaw gateway restart\n", []],
    ['#!/bin/sh\noc="/opt/bin/openclaw"\nread oc\n"$oc" gateway restart\n', []],
    ["#!/bin/sh\nopenclaw '' gateway restart\n", []],
    ["#!/bin/sh\nset -n\nopenclaw gateway restart\n", []],
    ["#!/bin/sh\nset -o noexec\nopenclaw gateway restart\n", []],
    ['#!/bin/sh\noc="/opt/bin/openclaw"\nprintf -v oc /bin/echo\n"$oc" gateway restart\n', []],
    ['#!/bin/sh\noc=/opt/bin/openclaw\nname=oc\nunset "$name"\n"$oc" gateway restart\n', []],
    ['#!/bin/zsh\noc=/opt/bin/openclaw\nother=${oc::=/bin/echo}\n"$oc" gateway restart\n', []],
    ['#!/bin/zsh\noc=/opt/bin/openclaw\necho "${oc::=/bin/echo}"\n"$oc" gateway restart\n', []],
    ['#!/bin/sh\nopenclaw_bin="echo /opt/bin/openclaw"\n$openclaw_bin gateway restart\n', []],
    ["#!/bin/sh\nIFS=o\nopenclaw_bin=openclaw\n$openclaw_bin gateway restart\n", []],
    ['#!/bin/bash\nRANDOM=openclaw\n"$RANDOM" gateway restart\n', []],
    [
      '#!/bin/zsh\nopenclaw_bin=/opt/bin/openclaw\nexec >${openclaw_bin::=/bin/echo}\n"$openclaw_bin" gateway restart\n',
      [],
    ],
  ])(
    "reads shell scripts without executing or confusing quoted data with commands (%#)",
    async (script, actions) => {
      const file = path.join(dir, "validator.sh");
      await fs.writeFile(file, script);
      addJob(label, ["/bin/sh", file]);
      expect(await findForeignLaunchdJobs({})).toEqual([
        expect.objectContaining({ gatewayActions: actions, safeToRemove: actions.length > 0 }),
      ]);
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

  it.each(["inline", "script", "direct"] as const)(
    "rejects shell-altering environment names for %s launches without examining values",
    async (mode) => {
      const file = path.join(dir, "validate.sh");
      await fs.writeFile(file, "#!/bin/bash\nset -x\n/usr/local/bin/openclaw gateway restart\n");
      const args =
        mode === "inline"
          ? ["/bin/bash", "-xc", "/usr/local/bin/openclaw gateway restart"]
          : mode === "direct"
            ? [file]
            : ["/bin/bash", file];
      for (const block of ["inherited environment", "default environment"]) {
        addJob(
          label,
          args,
          `\t${block} = {\n\t\tBASH_ENV => /tmp/profile\n\t}\n\tenvironment = {\n\t\tPATH => /usr/bin:/bin\n\t}\n`,
        );
        expect((await findForeignLaunchdJobs({}))[0], block).toMatchObject({
          gatewayActions: [],
          safeToRemove: false,
          diagnostic: "Shell environment alters execution; left unchanged.",
        });
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
        expect((await findForeignLaunchdJobs({}))[0], name).toMatchObject({
          gatewayActions: [],
          safeToRemove: false,
          diagnostic: "Shell environment alters execution; left unchanged.",
        });
      }
      addJob(
        label,
        args,
        "\tenvironment = {\n\t\tPATH => /usr/bin:/bin\n\t\tHOME => /home/operator\n\t\tOPENCLAW_EXAMPLE => SHELLOPTS=noexec BASH_ENV=ignored\n\t}\n",
      );
      expect((await findForeignLaunchdJobs({}))[0]).toMatchObject({
        gatewayActions: ["restart"],
        safeToRemove: true,
      });
    },
  );

  it.each([false, true])(
    "leaves non-shell CLI verification unaffected by shell environment names (env: %s)",
    async (viaEnv) => {
      const file = path.join(dir, "openclaw");
      await fs.writeFile(file, "#!/usr/bin/env node\n");
      addJob(
        label,
        [...(viaEnv ? ["/usr/bin/env"] : []), file, "gateway", "restart"],
        "\tenvironment = {\n\t\tSHELLOPTS => noexec\n\t}\n",
      );
      expect((await findForeignLaunchdJobs({}))[0]).toMatchObject({
        gatewayActions: ["restart"],
        safeToRemove: true,
      });
    },
  );

  it.each(
    ["openclaw", "openclaw.mjs", "node", "bun", "env"].flatMap((name) =>
      (name === "env" ? [false] : [false, true]).map((viaEnv) => ({ name, viaEnv })),
    ),
  )(
    "guards an executed shell script even when its filename is $name (env: $viaEnv)",
    async ({ name, viaEnv }) => {
      const file = path.join(dir, name);
      await fs.writeFile(file, "#!/bin/bash\n/usr/local/bin/openclaw gateway restart\n");
      const prefix =
        name === "env"
          ? [file, "/usr/local/bin/openclaw"]
          : name === "node" || name === "bun"
            ? [file, "/opt/openclaw.mjs"]
            : [file];
      addJob(
        label,
        [...(viaEnv ? ["/usr/bin/env"] : []), ...prefix, "gateway", "restart"],
        "\tenvironment = {\n\t\tSHELLOPTS => noexec\n\t}\n",
      );
      expect((await findForeignLaunchdJobs({}))[0]).toMatchObject({
        gatewayActions: [],
        safeToRemove: false,
        diagnostic: "Shell environment alters execution; left unchanged.",
      });
    },
  );

  it.each([
    { shebang: "#!/bin/bash", verified: true },
    { shebang: "#!/bin/sh", verified: true },
    { shebang: "#!/usr/bin/env bash", verified: true },
    { shebang: "#!/usr/bin/env sh", verified: true },
    { shebang: "#!/usr/bin/env zsh", verified: true },
    { shebang: "#!/usr/bin/python3", verified: false },
    { shebang: "", verified: false },
    { shebang: "#!/bin/bash -n", verified: false },
  ])(
    "verifies directly executed scripts only with an executing shell shebang ($shebang)",
    async ({ shebang, verified }) => {
      const file = path.join(dir, "validate.sh");
      await fs.writeFile(
        file,
        `${shebang}\nopenclaw_bin=/usr/local/bin/openclaw\n"$openclaw_bin" gateway restart\nfor attempt in 1 2; do\n  "$openclaw_bin" gateway status\n  sleep 1\ndone\n`,
      );
      addJob(label, [file]);
      expect(await findForeignLaunchdJobs({})).toEqual([
        expect.objectContaining({
          program: file,
          gatewayActions: verified ? ["restart"] : [],
          safeToRemove: verified,
        }),
      ]);
    },
  );

  it("does not inspect positional script arguments as executable files", async () => {
    const file = path.join(dir, "observer");
    const argument = path.join(dir, "restart.sh");
    await fs.writeFile(file, "#!/usr/bin/python3\n");
    await fs.writeFile(argument, "#!/bin/sh\nopenclaw gateway restart\n");
    addJob(label, [file, argument]);
    expect((await findForeignLaunchdJobs({}))[0]).toMatchObject({
      gatewayActions: [],
      safeToRemove: false,
    });
  });

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
      const file = path.join(dir, "harmless.sh");
      await fs.writeFile(file, "#!/bin/sh\nsleep 120\n");
      addJob(label, ["/bin/sh", ...prefix, file, "-c", "openclaw gateway restart"]);
      expect((await findForeignLaunchdJobs({}))[0]).toMatchObject({ safeToRemove: false });
    },
  );

  it("leaves oversized and symlinked shell scripts unverified", async () => {
    const file = path.join(dir, "validator.sh");
    await fs.writeFile(file, `openclaw gateway restart\n${"#".repeat(65536)}`);
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
    addJob(label, ["/opt/bin/openclaw", "gateway", "restart"]);
    const job = expectDefined((await findForeignLaunchdJobs({}))[0], "detected foreign job");
    const result = await repairForeignLaunchdJob(job, {});
    expect(result).toEqual({
      removed: true,
      detail: expect.stringContaining(`Removed stray launchd job ${label}`),
    });
    expect(jobs.has(label)).toBe(false);
    expect(exec.mock.calls.filter(([args]) => args[0] === "disable")).toEqual([]);
  });

  it("never trusts stale or caller-forged removal evidence", async () => {
    addJob(label, ["/opt/bin/openclaw", "gateway", "restart"]);
    const job = expectDefined((await findForeignLaunchdJobs({}))[0], "detected foreign job");
    addJob(label, ["/bin/echo", "gateway restart"]);
    expect((await repairForeignLaunchdJob(job, {})).removed).toBe(false);
    expect(exec.mock.calls.some(([args]) => ["bootout", "disable"].includes(args[0] ?? ""))).toBe(
      false,
    );
  });

  it("disables a verified foreign plist job at login while retaining its file", async () => {
    const plistPath = path.join(dir, "foreign.plist");
    await fs.writeFile(plistPath, "<plist><dict></dict></plist>");
    addJob(label, ["/opt/bin/openclaw", "gateway", "stop"]);
    jobs.set(
      label,
      jobs
        .get(label)!
        .replace("(submitted by launchctl[123])", plistPath)
        .replace("type = Submitted", "type = LaunchAgent"),
    );
    const job = expectDefined((await findForeignLaunchdJobs({}))[0], "detected foreign job");
    expect((await repairForeignLaunchdJob(job, {})).removed).toBe(true);
    expect(await fs.readFile(plistPath, "utf8")).toContain("<plist>");
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
    addJob(label, ["/opt/bin/openclaw", "gateway", "restart"]);
    const job = expectDefined((await findForeignLaunchdJobs({}))[0], "detected foreign job");
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
    const plistPath = path.join(dir, "foreign.plist");
    await fs.writeFile(plistPath, "<plist><dict></dict></plist>");
    addJob(label, ["/opt/bin/openclaw", "gateway", "restart"]);
    jobs.set(label, jobs.get(label)!.replace("(submitted by launchctl[123])", plistPath));
    const job = expectDefined((await findForeignLaunchdJobs({}))[0], "detected foreign job");
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
