import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "./exec-approvals-test-helpers.js";

vi.unmock("./exec-approvals.js");

let commandRequiresOpenClawLifecycleApproval: typeof import("./exec-approvals.js").commandRequiresOpenClawLifecycleApproval;

async function loadActualExecApprovals(): Promise<void> {
  vi.resetModules();
  const execApprovals =
    await vi.importActual<typeof import("./exec-approvals.js")>("./exec-approvals.js");
  commandRequiresOpenClawLifecycleApproval = execApprovals.commandRequiresOpenClawLifecycleApproval;
}

describe("OpenClaw lifecycle exec approvals", () => {
  beforeEach(async () => {
    await loadActualExecApprovals();
  });

  it("fails closed when deeply nested transparent carriers exhaust structured matching", () => {
    const wrappers = Array.from({ length: 40 }, () => "env");
    const argv = [...wrappers, "openclaw", "gateway", "restart"];
    const command = argv.join(" ");

    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [{ raw: command, argv }],
      }),
    ).toBe(true);
  });

  it("uses the resolved executable identity for lifecycle classification", () => {
    const command = "/tmp/oc gateway restart";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["/tmp/oc", "gateway", "restart"],
            resolution: {
              execution: {
                rawExecutable: "/tmp/oc",
                resolvedPath: "/tmp/oc",
                resolvedRealPath: "/usr/local/lib/node_modules/openclaw/dist/entry.js",
                executableName: "oc",
              },
              policy: {
                rawExecutable: "/tmp/oc",
                resolvedPath: "/tmp/oc",
                resolvedRealPath: "/usr/local/lib/node_modules/openclaw/dist/entry.js",
                executableName: "oc",
              },
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it("uses the resolved effective executable identity behind transparent carriers", () => {
    const command = "env /tmp/oc update --yes";
    const alias = makeMockExecutableResolution({
      rawExecutable: "/tmp/oc",
      executableName: "oc",
      resolvedPath: "/tmp/oc",
      resolvedRealPath: "/usr/local/lib/node_modules/openclaw/dist/entry.js",
    });
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "/tmp/oc", "update", "--yes"],
            resolution: makeMockCommandResolution({
              execution: alias,
              effectiveArgv: ["/tmp/oc", "update", "--yes"],
              wrapperChain: ["env"],
            }),
          },
        ],
      }),
    ).toBe(true);
  });

  it("does not treat arbitrary Node dist entrypoints as OpenClaw lifecycle commands", () => {
    const command = "node /tmp/other/dist/index.js gateway restart";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: true,
        segments: [
          { raw: command, argv: ["node", "/tmp/other/dist/index.js", "gateway", "restart"] },
        ],
      }),
    ).toBe(false);
  });

  it("uses cwd to classify relative OpenClaw Node entrypoints", () => {
    const command = "node ./dist/entry.js gateway restart";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        cwd: "/opt/openclaw",
        segments: [{ raw: command, argv: ["node", "./dist/entry.js", "gateway", "restart"] }],
      }),
    ).toBe(true);
  });

  it.each([
    ["--env-file", ".env"],
    ["--env-file-if-exists", ".env.local"],
    ["--future-value-option", "value"],
  ])("fails closed when Node option %s precedes an OpenClaw entrypoint", (option, value) => {
    const command = `node ${option} ${value} ./dist/entry.js gateway restart`;
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        cwd: "/opt/openclaw",
        segments: [
          {
            raw: command,
            argv: ["node", option, value, "./dist/entry.js", "gateway", "restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("does not classify relative Node entrypoints outside an OpenClaw cwd", () => {
    const command = "node ./dist/entry.js gateway restart";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        cwd: "/opt/other",
        segments: [{ raw: command, argv: ["node", "./dist/entry.js", "gateway", "restart"] }],
      }),
    ).toBe(false);
  });

  it("requires lifecycle approval when env -S expands a visible variable into a lifecycle command", () => {
    const command = "env -S '${CMD} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          CMD: "openclaw",
        },
        segments: [{ raw: command, argv: ["env", "-S", "${CMD} gateway restart"] }],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when env -S expands a visible bare variable into a lifecycle command", () => {
    const command = 'env -S "$CMD gateway restart"';
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          CMD: "openclaw",
        },
        segments: [{ raw: command, argv: ["env", "-S", "$CMD gateway restart"] }],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when shell defaults in env -S expand into a lifecycle command", () => {
    const command = 'env -S "${OC_BIN:-openclaw} gateway restart"';
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        segments: [{ raw: command, argv: ["env", "-S", "${OC_BIN:-openclaw} gateway restart"] }],
      }),
    ).toBe(true);
  });

  it("keeps partial shell defaults in env -S conservative after expansion", () => {
    const command = 'env -S "${OC_BIN:-openclaw} gateway restart"';
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: false,
        segments: [{ raw: command, argv: ["env", "-S", "${OC_BIN:-openclaw} gateway restart"] }],
      }),
    ).toBe(true);
  });

  it("keeps partial env-S leading bare executable variables conservative", () => {
    const command = "env -S '$SHELL -c \"openclaw gateway restart\"'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: false,
        segments: [{ raw: command, argv: ["env", "-S", '$SHELL -c "openclaw gateway restart"'] }],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when env -S is followed by visible shell variables", () => {
    const command = "env -S '${CMD}' $AREA $ACTION";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          ACTION: "restart",
          AREA: "gateway",
          CMD: "openclaw",
        },
        segments: [{ raw: command, argv: ["env", "-S", "${CMD}", "$AREA", "$ACTION"] }],
      }),
    ).toBe(true);
  });

  it("expands POSIX shell wrapper positional parameters before lifecycle classification", () => {
    const command = `sh -c 'openclaw "$1" "$2"' _ "$AREA" "$ACTION"`;
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { ACTION: "restart", AREA: "gateway" },
        envComplete: true,
        segments: [
          {
            raw: command,
            argv: ["sh", "-c", 'openclaw "$1" "$2"', "_", "$AREA", "$ACTION"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("does not use env -S assignments to expand trailing shell variables", () => {
    const command = "env -S 'AREA=gateway openclaw' $AREA restart";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        segments: [
          { raw: command, argv: ["env", "-S", "AREA=gateway openclaw", "$AREA", "restart"] },
        ],
      }),
    ).toBe(false);
  });

  it("does not treat env -S literal dollar executables as shell variables", () => {
    const command = "env -S \"'${CMD}'\" $AREA $ACTION";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: false,
        segments: [{ raw: command, argv: ["env", "-S", "'${CMD}'", "$AREA", "$ACTION"] }],
      }),
    ).toBe(false);
  });

  it("does not use empty fallback when env -S variable has a benign visible value", () => {
    const command = "env -S '${CMD}' openclaw gateway restart";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          CMD: "echo",
        },
        segments: [
          { raw: command, argv: ["env", "-S", "${CMD}", "openclaw", "gateway", "restart"] },
        ],
      }),
    ).toBe(false);
  });

  it("does not retokenize env -S variable values containing spaces", () => {
    const command = "env -S '${CMD}'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          CMD: "openclaw gateway restart",
        },
        segments: [{ raw: command, argv: ["env", "-S", "${CMD}"] }],
      }),
    ).toBe(false);
  });

  it("does not expand env -S variables inside single quotes", () => {
    const command = "env -S \"'${CMD}' gateway restart\"";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          CMD: "openclaw",
        },
        segments: [{ raw: command, argv: ["env", "-S", "'${CMD}' gateway restart"] }],
      }),
    ).toBe(false);
  });

  it("does not rescan substituted env -S variable values", () => {
    const command = "env -S '${CMD} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          CMD: "${NEXT}",
          NEXT: "openclaw",
        },
        segments: [{ raw: command, argv: ["env", "-S", "${CMD} gateway restart"] }],
      }),
    ).toBe(false);
  });

  it("restores backslash markers before matching env -S variable executable paths", () => {
    const command = "env -S '${CMD} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          CMD: String.raw`C:\tools\openclaw.exe`,
        },
        segments: [{ raw: command, argv: ["env", "-S", "${CMD} gateway restart"] }],
      }),
    ).toBe(true);
  });

  it("does not treat substituted env -S backslash escapes as env escapes", () => {
    const command = "CMD='openclaw\\_gateway\\_restart' env -S 'sh -c \"${CMD}\"'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [{ raw: command, argv: ["env", "-S", 'sh -c "${CMD}"'] }],
      }),
    ).toBe(false);
  });

  it("uses env -S assignments when escaped variables expand later inside shell wrappers", () => {
    const command = String.raw`env -S 'CMD=openclaw sh -c "\${CMD} gateway restart"'`;
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "-S", String.raw`CMD=openclaw sh -c "\${CMD} gateway restart"`],
          },
        ],
      }),
    ).toBe(true);
  });

  it("carries env assignments into unwrapped shell-wrapper payloads", () => {
    const command = "env CMD=$OC_BIN sh -c '$CMD gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          OC_BIN: "openclaw",
        },
        segments: [
          {
            raw: command,
            argv: ["env", "CMD=$OC_BIN", "sh", "-c", "$CMD gateway restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("keeps unresolved env -S assignments conservative when shell wrappers expand them later", () => {
    const command = String.raw`CMD=\${OC_BIN:-openclaw} env -S 'sh -c "\${CMD} gateway restart"'`;
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        segments: [
          {
            raw: command,
            argv: ["env", "-S", String.raw`sh -c "\${CMD} gateway restart"`],
          },
        ],
      }),
    ).toBe(true);
  });

  it("honors outer env unset before evaluating nested env -S variables", () => {
    const command =
      "/usr/bin/env -u PATH /usr/bin/env -S '${PATH}' /usr/bin/openclaw gateway restart";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          PATH: "echo",
        },
        segments: [
          {
            raw: command,
            argv: [
              "/usr/bin/env",
              "-u",
              "PATH",
              "/usr/bin/env",
              "-S",
              "${PATH}",
              "/usr/bin/openclaw",
              "gateway",
              "restart",
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("honors outer env clear before evaluating nested env -S variables", () => {
    const command = "/usr/bin/env - /usr/bin/env -S '${PATH}' /usr/bin/openclaw gateway restart";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          PATH: "echo",
        },
        segments: [
          {
            raw: command,
            argv: [
              "/usr/bin/env",
              "-",
              "/usr/bin/env",
              "-S",
              "${PATH}",
              "/usr/bin/openclaw",
              "gateway",
              "restart",
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("uses the incoming env for env -S before same-invocation unsets are applied", () => {
    const command = "env -u CMD -S '${CMD} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          CMD: "openclaw",
        },
        segments: [{ raw: command, argv: ["env", "-u", "CMD", "-S", "${CMD} gateway restart"] }],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when env -S expands a visible wrapper variable", () => {
    const command = "env WRAP=timeout env -S '${WRAP} 5s openclaw gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "WRAP=timeout", "env", "-S", "${WRAP} 5s openclaw gateway restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when visible env -S expands into nested env -S", () => {
    const command = "env CMD=env NEXT=openclaw env -S '${CMD} -S ${NEXT} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: [
              "env",
              "CMD=env",
              "NEXT=openclaw",
              "env",
              "-S",
              "${CMD} -S ${NEXT} gateway restart",
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when an escaped env -S variable reaches a nested env", () => {
    const command = String.raw`env -S 'CMD=openclaw env -S "\${CMD} gateway restart"'`;
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "-S", String.raw`CMD=openclaw env -S "\${CMD} gateway restart"`],
          },
        ],
      }),
    ).toBe(true);
  });

  it("expands visible shell variables in env assignment operands before env -S checks", () => {
    const command = "env CMD=$OC_BIN env -S '${CMD} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          OC_BIN: "openclaw",
        },
        segments: [
          {
            raw: command,
            argv: ["env", "CMD=$OC_BIN", "env", "-S", "${CMD} gateway restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("expands env assignment operands from the incoming shell environment", () => {
    const command = "env CMD=echo CMD=$CMD env -S '${CMD} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          CMD: "openclaw",
        },
        segments: [
          {
            raw: command,
            argv: ["env", "CMD=echo", "CMD=$CMD", "env", "-S", "${CMD} gateway restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("does not trust unsupported shell expansion forms in env assignment operands", () => {
    const command = "CMD=${OC_BIN:-openclaw} env -S '${CMD} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "CMD=${OC_BIN:-openclaw}", "env", "-S", "${CMD} gateway restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("carries env -S assignments into nested env -S expansion checks", () => {
    const command = String.raw`env -S 'CMD=openclaw AREA=gateway ACTION=restart env -S "\${CMD} \${AREA} \${ACTION}"'`;
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: [
              "env",
              "-S",
              String.raw`CMD=openclaw AREA=gateway ACTION=restart env -S "\${CMD} \${AREA} \${ACTION}"`,
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when env -S variables fill lifecycle positions behind a wrapper", () => {
    const command =
      "env OC_AREA=gateway OC_ACTION=restart env -S 'timeout 5s openclaw ${OC_AREA} ${OC_ACTION}'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: [
              "env",
              "OC_AREA=gateway",
              "OC_ACTION=restart",
              "env",
              "-S",
              "timeout 5s openclaw ${OC_AREA} ${OC_ACTION}",
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when a carrier OpenClaw executable is an env -S variable", () => {
    const command = "OC_BIN=openclaw env -S 'pnpm -C repo ${OC_BIN} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "-S", "pnpm -C repo ${OC_BIN} gateway restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when env -S variables fill OpenClaw option positions", () => {
    const command = "DEV=--dev env -S 'openclaw ${DEV} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "-S", "openclaw ${DEV} gateway restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when an unknown env -S executable may be a lifecycle wrapper", () => {
    const command = "WRAP=timeout env -S '${WRAP} 5s openclaw gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "-S", "${WRAP} 5s openclaw gateway restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when an unknown env -S executable may be a shell wrapper", () => {
    const command = "WRAP=${MISSING:-sh} env -S '${WRAP} -c \"openclaw gateway restart\"'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "-S", '${WRAP} -c "openclaw gateway restart"'],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when an unknown env -S executable may be another supported shell", () => {
    const command = "WRAP=${MISSING:-zsh} env -S '${WRAP} -c \"openclaw gateway restart\"'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "-S", '${WRAP} -c "openclaw gateway restart"'],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when an unknown env -S executable may be a shell multiplexer", () => {
    const command = "WRAP=${MISSING:-busybox} env -S '${WRAP} sh -c \"openclaw gateway restart\"'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "-S", '${WRAP} sh -c "openclaw gateway restart"'],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when an unknown env -S executable may be flock", () => {
    const command =
      "WRAP=flock env -S '${WRAP} /tmp/oc.lock systemctl --user restart openclaw-gateway.service'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: [
              "env",
              "-S",
              "${WRAP} /tmp/oc.lock systemctl --user restart openclaw-gateway.service",
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when an unknown env -S executable may be sudo", () => {
    const command =
      "WRAP=sudo env -S '${WRAP} -u root systemctl --user restart openclaw-gateway.service'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: [
              "env",
              "-S",
              "${WRAP} -u root systemctl --user restart openclaw-gateway.service",
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("carries sudo environment assignments into nested env -S lifecycle detection", () => {
    const command = "sudo CMD=openclaw env -S '${CMD} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        segments: [
          {
            raw: command,
            argv: ["sudo", "CMD=openclaw", "env", "-S", "${CMD} gateway restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("carries sudo environment assignments after value-taking sudo options", () => {
    const command = "sudo -R /jail CMD=openclaw env -S '${CMD} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        segments: [
          {
            raw: command,
            argv: ["sudo", "-R", "/jail", "CMD=openclaw", "env", "-S", "${CMD} gateway restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("keeps unresolved sudo environment assignments conservative for nested env -S lifecycle detection", () => {
    const command = "sudo CMD=${MISSING} env -S '${CMD} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        segments: [
          {
            raw: command,
            argv: ["sudo", "CMD=${MISSING}", "env", "-S", "${CMD} gateway restart"],
          },
        ],
      }),
    ).toBe(true);
  });
});
