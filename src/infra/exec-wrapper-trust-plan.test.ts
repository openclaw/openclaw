// Covers trust-plan unwrapping for exec command wrappers.
import { describe, expect, test } from "vitest";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";

test.each(["darwin", "linux", "win32"] as const)(
  "retains an unbound outer dispatcher when policy unwrapping stops on %s",
  (platform) => {
    expect(
      resolveExecWrapperTrustPlan(["xcrun", "env", "FOO=bar", "ls"], undefined, platform)
        .dispatchChain,
    ).toBeNull();
  },
);

const posix = process.platform !== "win32";
const opaqueShell = { shellWrapperExecutable: true };
const inlineShell = { ...opaqueShell, shellInlineCommand: "echo hi" };
const blocked = (blockedWrapper: string) => ({ policyBlocked: true, blockedWrapper });
const shell = ["sh", "-c", "echo hi"];

type TrustPlan = ReturnType<typeof resolveExecWrapperTrustPlan>;
const defaultPolicyPlan: Omit<TrustPlan, "argv" | "policyArgv" | "dispatchChain"> = {
  wrapperChain: [],
  wrapperInvocations: [],
  policyBlocked: false,
  shellWrapperExecutable: false,
  shellInlineCommand: null,
};

// Explicit suffix offsets keep expected argv independent of wrapper parsing.
function unwrapped(
  argv: string[],
  target: number,
  wrappers: [string, number][],
  extra: Partial<TrustPlan> = {},
): [string[], Partial<TrustPlan>] {
  return [
    argv,
    {
      argv: argv.slice(target),
      policyArgv: argv.slice(target),
      wrapperChain: wrappers.map(([wrapper]) => wrapper),
      wrapperInvocations: wrappers.map(([wrapper, offset]) => ({
        wrapper,
        sourceArgv: argv.slice(offset),
      })),
      ...extra,
    },
  ];
}

type TrustCase = [
  string,
  boolean,
  string[],
  Partial<TrustPlan>,
  { depth?: number; platform?: NodeJS.Platform }?,
];

describe("resolveExecWrapperTrustPlan", () => {
  test.each<TrustCase>([
    [
      "command carrier",
      posix,
      ...unwrapped(["command", "curl", "https://example.invalid"], 1, [["command", 0]]),
    ],
    [
      "path-qualified command stays opaque",
      posix,
      ["/tmp/openclaw-test/command", "curl", "https://example.invalid"],
      {},
    ],
    [
      "Windows command stays opaque",
      true,
      ["command", "curl", "https://example.invalid"],
      {},
      { platform: "win32" },
    ],
    [
      "env plus command carrier",
      posix,
      ...unwrapped(["env", "command", "--", "python3", "/tmp/run.py"], 3, [
        ["env", 0],
        ["command", 1],
      ]),
    ],
    ["builtin carrier", posix, ...unwrapped(["builtin", "printf", "ok"], 1, [["builtin", 0]])],
    [
      "exec -a carrier",
      posix,
      ...unwrapped(
        ["exec", "-a", "friendly-name", "bash", "/tmp/run.sh"],
        3,
        [["exec", 0]],
        opaqueShell,
      ),
    ],
    ["tcsh startup stays opaque", true, ["tcsh", "-c", "echo hi"], opaqueShell],
    ["nushell --commands", true, ["nu", "--commands", "echo hi"], inlineShell],
    ["nushell --execute", true, ["nu", "--execute", "echo hi"], inlineShell],
    [
      "nushell --config stays opaque",
      true,
      ["nu", "--config=/tmp/evil.nu", "--commands", "echo hi"],
      opaqueShell,
    ],
    [
      "nushell --env-config stays opaque",
      true,
      ["nu", "--env-config", "/tmp/evil.nu", "--commands", "echo hi"],
      opaqueShell,
    ],
    ["yash --cmdline", true, ["yash", "--cmdline", "echo hi"], inlineShell],
    ["yash -xc", true, ["yash", "-xc", "echo hi"], inlineShell],
    ["command -v blocked", posix, ["command", "-v", "curl"], blocked("command")],
    [
      "command -p blocked",
      posix,
      ["command", "-p", "curl", "https://example.invalid"],
      blocked("command"),
    ],
    [
      "caffeinate unwraps",
      posix,
      ...unwrapped(
        ["/usr/bin/caffeinate", "-d", "-w", "42", ...shell],
        4,
        [["caffeinate", 0]],
        inlineShell,
      ),
    ],
    [
      "time plus busybox",
      posix,
      ...unwrapped(
        ["/usr/bin/time", "-p", "busybox", ...shell],
        3,
        [
          ["time", 0],
          ["busybox", 2],
        ],
        {
          policyArgv: ["busybox", ...shell],
          ...inlineShell,
        },
      ),
    ],
    [
      "script blocked",
      process.platform === "darwin" || process.platform === "freebsd",
      ["/usr/bin/script", "-q", "/dev/null", ...shell],
      {
        wrapperInvocations: [
          {
            wrapper: "script",
            sourceArgv: ["/usr/bin/script", "-q", "/dev/null", ...shell],
          },
        ],
        ...blocked("script"),
      },
    ],
    [
      "sandbox-exec unwraps",
      posix,
      ...unwrapped(
        ["/usr/bin/sandbox-exec", "-p", "(allow default)", ...shell],
        3,
        [["sandbox-exec", 0]],
        inlineShell,
      ),
    ],
    [
      "pnpm exec stays opaque",
      true,
      ["pnpm", "--reporter", "silent", "exec", "--", "tsx", "./run.ts"],
      {},
    ],
    ["npx --call stays opaque", true, ["npx", "--call", "sh -c 'echo hi'"], {}],
    ["bash login stays opaque", posix, ["bash", "--login", "-c", "echo hi"], opaqueShell],
    ["busybox non-shell blocked", true, ["busybox", "sed", "-n", "1p"], blocked("busybox")],
    [
      "outer-wrapper depth overflow",
      true,
      ...unwrapped(
        ["nohup", "timeout", "5s", "busybox", "sh", "-lc", "echo hi"],
        3,
        [
          ["nohup", 0],
          ["timeout", 1],
        ],
        blocked("busybox"),
      ),
      { depth: 2 },
    ],
    [
      "time plus blocked env",
      posix,
      ["/usr/bin/time", "-p", "/usr/bin/env", "FOO=bar", "sh", "-lc", "echo hi"],
      {
        argv: ["/usr/bin/env", "FOO=bar", "sh", "-lc", "echo hi"],
        policyArgv: ["/usr/bin/env", "FOO=bar", "sh", "-lc", "echo hi"],
        wrapperInvocations: [
          {
            wrapper: "time",
            sourceArgv: ["/usr/bin/time", "-p", "/usr/bin/env", "FOO=bar", "sh", "-lc", "echo hi"],
          },
          { wrapper: "env", sourceArgv: ["/usr/bin/env", "FOO=bar", "sh", "-lc", "echo hi"] },
        ],
        policyBlocked: true,
        blockedWrapper: "env",
      },
    ],
  ])(
    "trust plan: %s",
    (_name, enabled, argv, expected, { depth, platform }: NonNullable<TrustCase[4]> = {}) => {
      if (!enabled) {
        return;
      }
      const { dispatchChain: _dispatchChain, ...policyPlan } = resolveExecWrapperTrustPlan(
        argv,
        depth,
        platform,
      );
      expect(policyPlan).toEqual({ argv, policyArgv: argv, ...defaultPolicyPlan, ...expected });
    },
  );
});
