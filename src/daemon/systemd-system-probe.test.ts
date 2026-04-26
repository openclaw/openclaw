import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("../../test/helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      execFile: Object.assign(execFileMock, {
        __promisify__: vi.fn(),
      }) as typeof import("node:child_process").execFile,
    },
  );
});

import {
  pickPrimaryGatewayUnit,
  probeSystemdSystemServices,
  resolveCandidateSystemUnits,
} from "./systemd-system-probe.js";

type ShowReply = {
  activeState?: string;
  subState?: string;
  mainPid?: number;
  loadState?: string;
  controlGroup?: string;
};

function formatShowOutput(reply: ShowReply): string {
  return [
    `ActiveState=${reply.activeState ?? ""}`,
    `SubState=${reply.subState ?? ""}`,
    `MainPID=${reply.mainPid ?? 0}`,
    `LoadState=${reply.loadState ?? ""}`,
    `ControlGroup=${reply.controlGroup ?? ""}`,
  ].join("\n");
}

describe("resolveCandidateSystemUnits", () => {
  it("includes the canonical gateway, legacy, host-gateway, node, and node-host units", () => {
    const units = resolveCandidateSystemUnits({});
    expect(units).toEqual(
      expect.arrayContaining([
        "openclaw-gateway.service",
        "openclaw-host-gateway.service",
        "openclaw-node.service",
        "openclaw-node-host.service",
        "clawdbot-gateway.service",
      ]),
    );
  });

  it("honors an explicit OPENCLAW_SYSTEMD_UNIT override", () => {
    const units = resolveCandidateSystemUnits({
      OPENCLAW_SYSTEMD_UNIT: "my-openclaw",
    });
    expect(units).toContain("my-openclaw.service");
  });
});

describe("probeSystemdSystemServices", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("reports active system-level units and their cgroups", async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      // Every invocation must be for `systemctl show <unit> --no-page --property ...`.
      expect(args[0]).toBe("show");
      expect(args).not.toContain("--user");
      const unit = args[1] as string;
      if (unit === "openclaw-host-gateway.service") {
        cb(
          null,
          formatShowOutput({
            activeState: "active",
            subState: "running",
            mainPid: 1131058,
            loadState: "loaded",
            controlGroup: "/system.slice/openclaw-host-gateway.service",
          }),
          "",
        );
        return;
      }
      if (unit === "openclaw-node-host.service") {
        cb(
          null,
          formatShowOutput({
            activeState: "active",
            subState: "running",
            mainPid: 1131042,
            loadState: "loaded",
            controlGroup: "/system.slice/openclaw-node-host.service",
          }),
          "",
        );
        return;
      }
      // Other candidates: loaded=not-found style (no mainpid, no loadstate)
      cb(null, formatShowOutput({ activeState: "inactive", loadState: "not-found" }), "");
    });

    const outcome = await probeSystemdSystemServices({});
    expect(outcome.systemBusAvailable).toBe(true);
    const names = outcome.units.map((u) => u.unitName).toSorted();
    expect(names).toEqual(["openclaw-host-gateway.service", "openclaw-node-host.service"]);
    const gateway = outcome.units.find((u) => u.unitName === "openclaw-host-gateway.service");
    expect(gateway).toMatchObject({
      activeState: "active",
      mainPid: 1131058,
      cgroup: "/system.slice/openclaw-host-gateway.service",
      loaded: true,
    });
  });

  it("flags systemBusAvailable=false when every probe fails (non-zero code)", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error("Failed to connect to bus") as Error & {
        stderr?: string;
        code?: number;
      };
      err.stderr = "Failed to connect to bus";
      err.code = 1;
      cb(err, "", "Failed to connect to bus");
    });
    const outcome = await probeSystemdSystemServices({});
    expect(outcome.systemBusAvailable).toBe(false);
    expect(outcome.units).toEqual([]);
  });
});

describe("pickPrimaryGatewayUnit", () => {
  it("prefers the canonical gateway unit", () => {
    const gateway = {
      unitName: "openclaw-gateway.service",
      activeState: "active",
      mainPid: 1,
    };
    const nodeHost = {
      unitName: "openclaw-node-host.service",
      activeState: "active",
      mainPid: 2,
    };
    expect(pickPrimaryGatewayUnit({}, [nodeHost, gateway])).toBe(gateway);
  });

  it("falls back to the host-gateway variant when canonical is absent", () => {
    const hostGateway = {
      unitName: "openclaw-host-gateway.service",
      activeState: "active",
      mainPid: 10,
    };
    const nodeHost = {
      unitName: "openclaw-node-host.service",
      activeState: "active",
      mainPid: 20,
    };
    expect(pickPrimaryGatewayUnit({}, [nodeHost, hostGateway])).toBe(hostGateway);
  });

  it("returns null when there are no units", () => {
    expect(pickPrimaryGatewayUnit({}, [])).toBeNull();
  });
});
