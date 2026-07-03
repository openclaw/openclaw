import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("requires lifecycle approval when an env -S process target may be OpenClaw", () => {
    const command = "PATTERN=${MISSING:-openclaw} env -S 'pkill ${PATTERN}'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "-S", "pkill ${PATTERN}"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when ordinary shell variables fill OpenClaw lifecycle tokens", () => {
    const command = "openclaw $OC_AREA $OC_ACTION";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [{ raw: command, argv: ["openclaw", "$OC_AREA", "$OC_ACTION"] }],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when ordinary shell assignments fill systemctl lifecycle tokens", () => {
    const command = "ACTION=restart UNIT=openclaw-gateway.service systemctl --user $ACTION $UNIT";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: [
              "ACTION=restart",
              "UNIT=openclaw-gateway.service",
              "systemctl",
              "--user",
              "$ACTION",
              "$UNIT",
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when ordinary shell assignments fill process targets", () => {
    const command = 'PATTERN=openclaw pkill "$PATTERN"';
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [{ raw: command, argv: ["PATTERN=openclaw", "pkill", "$PATTERN"] }],
      }),
    ).toBe(true);
  });

  it("does not apply same-command prefix assignments during shell word expansion", () => {
    const command = "ACTION=status UNIT=openclaw-gateway.service systemctl --user $ACTION $UNIT";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        segments: [
          {
            raw: command,
            argv: [
              "ACTION=status",
              "UNIT=openclaw-gateway.service",
              "systemctl",
              "--user",
              "$ACTION",
              "$UNIT",
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  it("expands command arguments before applying same-command prefix assignments", () => {
    const command = "ACTION=status UNIT=nginx.service systemctl --user $ACTION $UNIT";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          ACTION: "restart",
          UNIT: "openclaw-gateway.service",
        },
        segments: [
          {
            raw: command,
            argv: [
              "ACTION=status",
              "UNIT=nginx.service",
              "systemctl",
              "--user",
              "$ACTION",
              "$UNIT",
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("keeps partial environments conservative for ordinary shell lifecycle variables", () => {
    const command = "openclaw $OC_AREA $OC_ACTION";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { PATH: "/usr/bin" },
        envComplete: false,
        segments: [{ raw: command, argv: ["openclaw", "$OC_AREA", "$OC_ACTION"] }],
      }),
    ).toBe(true);
  });

  it("treats missing ordinary shell variables as empty when the environment is complete", () => {
    const command = "openclaw $OC_AREA $OC_ACTION";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { PATH: "/usr/bin" },
        envComplete: true,
        segments: [{ raw: command, argv: ["openclaw", "$OC_AREA", "$OC_ACTION"] }],
      }),
    ).toBe(false);
  });

  it("keeps partial environments conservative for gateway call method variables", () => {
    const command = "openclaw gateway call $METHOD";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { PATH: "/usr/bin" },
        envComplete: false,
        segments: [{ raw: command, argv: ["openclaw", "gateway", "call", "$METHOD"] }],
      }),
    ).toBe(true);
  });

  it("treats missing gateway call method variables as empty when the environment is complete", () => {
    const command = "openclaw gateway call $METHOD";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { PATH: "/usr/bin" },
        envComplete: true,
        segments: [{ raw: command, argv: ["openclaw", "gateway", "call", "$METHOD"] }],
      }),
    ).toBe(false);
  });

  it("carries assignment-only shell variables into later lifecycle segments", () => {
    const command = "OC_AREA=gateway; OC_ACTION=restart; openclaw $OC_AREA $OC_ACTION";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: true,
        segments: [
          { raw: "OC_AREA=gateway", argv: ["OC_AREA=gateway"] },
          { raw: "OC_ACTION=restart", argv: ["OC_ACTION=restart"] },
          { raw: "openclaw $OC_AREA $OC_ACTION", argv: ["openclaw", "$OC_AREA", "$OC_ACTION"] },
        ],
      }),
    ).toBe(true);
  });

  it("preserves possible assignments after shell control-flow prefixes", () => {
    const command =
      "if true; then ACTION=restart; else ACTION=status; fi; openclaw gateway $ACTION";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: true,
        segments: [
          { raw: "if true", argv: ["if", "true"] },
          { raw: "then ACTION=restart", argv: ["then", "ACTION=restart"] },
          { raw: "else ACTION=status", argv: ["else", "ACTION=status"] },
          { raw: "fi", argv: ["fi"] },
          { raw: "openclaw gateway $ACTION", argv: ["openclaw", "gateway", "$ACTION"] },
        ],
      }),
    ).toBe(true);
  });

  it("preserves possible env values across conditional assignment segments", () => {
    const command =
      "sh -c 'ACTION=restart; false && ACTION=status; systemctl --user $ACTION openclaw-gateway.service'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: true,
        segments: [
          {
            raw: command,
            argv: [
              "sh",
              "-c",
              "ACTION=restart; false && ACTION=status; systemctl --user $ACTION openclaw-gateway.service",
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval for unsupported POSIX executable expansions", () => {
    const command = "bash -c '${CMD:0} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { CMD: "openclaw" },
        envComplete: true,
        segments: [{ raw: command, argv: ["bash", "-c", "${CMD:0} gateway restart"] }],
      }),
    ).toBe(true);
  });

  it.each([
    {
      command: 'cmd.exe /d /s /c "%CMD% gateway restart"',
      argv: ["cmd.exe", "/d", "/s", "/c", "%CMD% gateway restart"],
    },
    {
      command: 'cmd.exe /d /v:on /c "!CMD! gateway restart"',
      argv: ["cmd.exe", "/d", "/v:on", "/c", "!CMD! gateway restart"],
    },
    {
      command: 'cmd.exe /d /s /c "%CMD:~0,8% gateway restart"',
      argv: ["cmd.exe", "/d", "/s", "/c", "%CMD:~0,8% gateway restart"],
    },
    {
      command: 'cmd.exe /d /s /c "%CMD:claw=claw% gateway restart"',
      argv: ["cmd.exe", "/d", "/s", "/c", "%CMD:claw=claw% gateway restart"],
    },
  ])("requires lifecycle approval for cmd variable expansion $command", ({ command, argv }) => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { CMD: "openclaw" },
        envComplete: true,
        segments: [{ raw: command, argv }],
      }),
    ).toBe(true);
  });

  it("tracks cmd set assignments before delayed executable expansion", () => {
    const command = 'cmd.exe /d /v:on /c "set A=op&set B=enclaw&set C=!A!!B!&!C! gateway restart"';
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: true,
        segments: [
          {
            raw: command,
            argv: [
              "cmd.exe",
              "/d",
              "/v:on",
              "/c",
              "set A=op&set B=enclaw&set C=!A!!B!&!C! gateway restart",
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("keeps cmd percent expansion on the pre-command environment", () => {
    const command = 'cmd.exe /d /s /c "set CMD=openclaw & %CMD% gateway restart"';
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { CMD: "echo" },
        envComplete: true,
        segments: [
          {
            raw: command,
            argv: ["cmd.exe", "/d", "/s", "/c", "set CMD=openclaw & %CMD% gateway restart"],
          },
        ],
      }),
    ).toBe(false);
  });

  it("retains pre-command cmd percent values after a local set", () => {
    const command = 'cmd.exe /d /s /c "set CMD=echo & %CMD% gateway restart"';
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { CMD: "openclaw" },
        envComplete: true,
        segments: [
          {
            raw: command,
            argv: ["cmd.exe", "/d", "/s", "/c", "set CMD=echo & %CMD% gateway restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("resolves harmless cmd variable modifiers without failing closed", () => {
    const command = 'cmd.exe /d /s /c "%CMD:~0,4% gateway restart"';
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { CMD: "openclaw" },
        envComplete: true,
        segments: [
          { raw: command, argv: ["cmd.exe", "/d", "/s", "/c", "%CMD:~0,4% gateway restart"] },
        ],
      }),
    ).toBe(false);
  });

  it("does not treat harmless assignment-only shell variables as lifecycle mutations", () => {
    const command = "OC_AREA=gateway; OC_ACTION=status; openclaw $OC_AREA $OC_ACTION";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: true,
        segments: [
          { raw: "OC_AREA=gateway", argv: ["OC_AREA=gateway"] },
          { raw: "OC_ACTION=status", argv: ["OC_ACTION=status"] },
          { raw: "openclaw $OC_AREA $OC_ACTION", argv: ["openclaw", "$OC_AREA", "$OC_ACTION"] },
        ],
      }),
    ).toBe(false);
  });

  it("carries exported shell variables into later lifecycle segments", () => {
    const command =
      "export OC_AREA=gateway; export OC_ACTION=restart; openclaw $OC_AREA $OC_ACTION";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: true,
        segments: [
          { raw: "export OC_AREA=gateway", argv: ["export", "OC_AREA=gateway"] },
          { raw: "export OC_ACTION=restart", argv: ["export", "OC_ACTION=restart"] },
          { raw: "openclaw $OC_AREA $OC_ACTION", argv: ["openclaw", "$OC_AREA", "$OC_ACTION"] },
        ],
      }),
    ).toBe(true);
  });

  it("does not treat harmless exported shell variables as lifecycle mutations", () => {
    const command = "export OC_AREA=gateway; export OC_ACTION=status; openclaw $OC_AREA $OC_ACTION";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: true,
        segments: [
          { raw: "export OC_AREA=gateway", argv: ["export", "OC_AREA=gateway"] },
          { raw: "export OC_ACTION=status", argv: ["export", "OC_ACTION=status"] },
          { raw: "openclaw $OC_AREA $OC_ACTION", argv: ["openclaw", "$OC_AREA", "$OC_ACTION"] },
        ],
      }),
    ).toBe(false);
  });

  it("field-splits expanded shell variables before matching OpenClaw lifecycle tokens", () => {
    const command = "ARGS='gateway restart'; openclaw $ARGS";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: true,
        segments: [
          { raw: "ARGS='gateway restart'", argv: ["ARGS=gateway restart"] },
          { raw: "openclaw $ARGS", argv: ["openclaw", "$ARGS"] },
        ],
      }),
    ).toBe(true);
  });

  it("field-splits expanded shell variables before matching systemctl lifecycle tokens", () => {
    const command = "ARGS='restart openclaw-gateway.service'; systemctl --user $ARGS";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: true,
        segments: [
          {
            raw: "ARGS='restart openclaw-gateway.service'",
            argv: ["ARGS=restart openclaw-gateway.service"],
          },
          { raw: "systemctl --user $ARGS", argv: ["systemctl", "--user", "$ARGS"] },
        ],
      }),
    ).toBe(true);
  });

  it("does not treat harmless field-split shell variables as lifecycle mutations", () => {
    const command = "ARGS='gateway status'; openclaw $ARGS";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: true,
        segments: [
          { raw: "ARGS='gateway status'", argv: ["ARGS=gateway status"] },
          { raw: "openclaw $ARGS", argv: ["openclaw", "$ARGS"] },
        ],
      }),
    ).toBe(false);
  });

  it("does not field-split quoted shell variable expansions", () => {
    const command = `ARGS='gateway restart'; openclaw "$ARGS"`;
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          { raw: "ARGS='gateway restart'", argv: ["ARGS=gateway restart"] },
          { raw: 'openclaw "$ARGS"', argv: ["openclaw", "$ARGS"] },
        ],
      }),
    ).toBe(false);
  });

  it("does not expand single-quoted POSIX lifecycle variables", () => {
    const command = "openclaw gateway '$ACTION'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { ACTION: "restart" },
        envComplete: true,
        segments: [{ raw: command, argv: ["openclaw", "gateway", "$ACTION"] }],
      }),
    ).toBe(false);
  });

  it("field-splits only the shell arguments with unquoted variable expansions", () => {
    const command = `ARGS='gateway restart'; EXTRA=foo; openclaw "$ARGS" $EXTRA`;
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          { raw: "ARGS='gateway restart'", argv: ["ARGS=gateway restart"] },
          { raw: "EXTRA=foo", argv: ["EXTRA=foo"] },
          {
            raw: 'openclaw "$ARGS" $EXTRA',
            argv: ["openclaw", "$ARGS", "$EXTRA"],
          },
        ],
      }),
    ).toBe(false);
  });

  it("requires lifecycle approval when POSIX defaults fill OpenClaw lifecycle tokens", () => {
    const command = "openclaw ${OC_AREA:-gateway} ${OC_ACTION:-restart}";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: true,
        segments: [
          {
            raw: command,
            argv: ["openclaw", "${OC_AREA:-gateway}", "${OC_ACTION:-restart}"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when unknown POSIX plus expansion can fill OpenClaw executable", () => {
    const command = 'env -S "${OC_BIN+openclaw} gateway restart"';
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: false,
        segments: [{ raw: command, argv: ["env", "-S", "${OC_BIN+openclaw} gateway restart"] }],
      }),
    ).toBe(true);
  });

  it("requires lifecycle approval when POSIX defaults fill systemctl lifecycle tokens", () => {
    const command = "systemctl --user ${ACTION:-restart} ${UNIT:-openclaw-gateway.service}";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: true,
        segments: [
          {
            raw: command,
            argv: [
              "systemctl",
              "--user",
              "${ACTION:-restart}",
              "${UNIT:-openclaw-gateway.service}",
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("does not require lifecycle approval when POSIX defaults keep OpenClaw read-only", () => {
    const command = "openclaw ${OC_AREA:-gateway} ${OC_ACTION:-status}";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: true,
        segments: [
          {
            raw: command,
            argv: ["openclaw", "${OC_AREA:-gateway}", "${OC_ACTION:-status}"],
          },
        ],
      }),
    ).toBe(false);
  });

  it("does not require lifecycle approval when unknown POSIX plus expansion stays benign", () => {
    const command = 'env -S "${OC_BIN+echo} gateway restart"';
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        envComplete: false,
        segments: [{ raw: command, argv: ["env", "-S", "${OC_BIN+echo} gateway restart"] }],
      }),
    ).toBe(false);
  });

  it("does not require lifecycle approval when an env -S process option variable is not a target", () => {
    const command = "SIGNAL=TERM env -S 'pkill -${SIGNAL} nginx'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "-S", "pkill -${SIGNAL} nginx"],
          },
        ],
      }),
    ).toBe(false);
  });

  it("does not require lifecycle approval when an env -S process option value variable is not a target", () => {
    const command = "SIGNAL=TERM env -S 'pkill --signal ${SIGNAL} nginx'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "-S", "pkill --signal ${SIGNAL} nginx"],
          },
        ],
      }),
    ).toBe(false);
  });

  it("still requires lifecycle approval when an env -S process flag is followed by an OpenClaw target", () => {
    const command = "env -S 'pkill -x openclaw'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "-S", "pkill -x openclaw"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("does not reintroduce known benign env -S variables after partial substitution", () => {
    const command = "env -S '${CMD} gateway ${ACTION}'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          CMD: "echo",
        },
        segments: [{ raw: command, argv: ["env", "-S", "${CMD} gateway ${ACTION}"] }],
      }),
    ).toBe(false);
  });

  it("uses shell-prefix assignments when evaluating env -S variables", () => {
    const command = "CMD=openclaw env -S 'sh -c \"${CMD} gateway restart\"'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "-S", 'sh -c "${CMD} gateway restart"'],
          },
        ],
      }),
    ).toBe(true);
  });

  it("treats env -S assignments after -- as environment operands before lifecycle commands", () => {
    const command = "env -S '-- FOO=bar openclaw gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [{ raw: command, argv: ["env", "-S", "-- FOO=bar openclaw gateway restart"] }],
      }),
    ).toBe(true);
  });

  it("treats dash-prefixed env -S assignments after -- as environment operands before lifecycle commands", () => {
    const command = "env -S '-- -X=1 openclaw gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [{ raw: command, argv: ["env", "-S", "-- -X=1 openclaw gateway restart"] }],
      }),
    ).toBe(true);
  });

  it("treats dash-prefixed env assignments after -- as environment operands before lifecycle commands", () => {
    const command = "env -- -X=1 openclaw gateway restart";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [{ raw: command, argv: ["env", "--", "-X=1", "openclaw", "gateway", "restart"] }],
      }),
    ).toBe(true);
  });

  it("does not re-treat benign shell-prefix assignments as unknown env -S executables", () => {
    const command = "CMD=echo env -S '${CMD} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        segments: [
          {
            raw: command,
            argv: ["env", "-S", "${CMD} gateway restart"],
          },
        ],
      }),
    ).toBe(false);
  });

  it("treats missing env -S variables as empty when env is known", () => {
    const command = "env -S '${CMD} gateway restart'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        segments: [{ raw: command, argv: ["env", "-S", "${CMD} gateway restart"] }],
      }),
    ).toBe(false);
  });

  it("does not treat env -S bare variables as executable expansions", () => {
    const command = "env -S '$CMD'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          CMD: "openclaw gateway restart",
        },
        segments: [{ raw: command, argv: ["env", "-S", "$CMD"] }],
      }),
    ).toBe(false);
  });

  it("treats missing env -S leading bare executable variables as empty when env is complete", () => {
    const command = "env -S '$SHELL -c \"openclaw gateway restart\"'";
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {},
        segments: [{ raw: command, argv: ["env", "-S", '$SHELL -c "openclaw gateway restart"'] }],
      }),
    ).toBe(false);
  });

  it("does not treat escaped env -S variables as executable expansions", () => {
    const command = String.raw`env -S '\${CMD}'`;
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: {
          CMD: "openclaw gateway restart",
        },
        segments: [{ raw: command, argv: ["env", "-S", String.raw`\${CMD}`] }],
      }),
    ).toBe(false);
  });
});
