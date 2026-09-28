// Version reporting for daemon status: CLI, Gateway, and the installed service install.
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import {
  getMockCallOutput,
  spyRuntimeErrors,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "../test-runtime-capture.js";
import type { DaemonStatus } from "./status.gather.js";
import { printDaemonStatus } from "./status.print.js";

function humanOutput(): string {
  return stripVTControlCharacters(
    [
      getMockCallOutput(vi.mocked(defaultRuntime.log)),
      getMockCallOutput(vi.mocked(defaultRuntime.error)),
    ].join("\n"),
  );
}

type StatusFixture = {
  cliVersion?: string;
  cliEntrypoint?: string;
  layout?: DaemonStatus["service"]["layout"];
  gatewayVersion?: string;
  rpcVersion?: string;
};

function createStatus(params: StatusFixture): DaemonStatus {
  return {
    ...(params.cliVersion
      ? { cli: { version: params.cliVersion, entrypoint: params.cliEntrypoint } }
      : {}),
    service: {
      label: "Daemon",
      installed: true,
      loaded: true,
      loadState: { status: "loaded" },
      loadedText: "loaded",
      notLoadedText: "not loaded",
      runtime: { status: "running", pid: 9001 },
      ...(params.layout ? { layout: params.layout } : {}),
    },
    gateway: {
      bindMode: "loopback",
      bindHost: "127.0.0.1",
      port: 18789,
      portSource: "env/config",
      probeUrl: "ws://127.0.0.1:18789",
      ...(params.gatewayVersion ? { version: params.gatewayVersion } : {}),
    },
    ...(params.rpcVersion
      ? {
          rpc: {
            ok: true,
            kind: "connect",
            capability: "write_capable",
            url: "ws://127.0.0.1:18789",
            server: { version: params.rpcVersion },
          },
        }
      : {}),
    extraServices: [],
  } as DaemonStatus;
}

beforeEach(() => {
  spyRuntimeLogs(defaultRuntime);
  spyRuntimeErrors(defaultRuntime);
  spyRuntimeJson(defaultRuntime);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("daemon status version reporting", () => {
  it("prints CLI and gateway versions with readable guidance when they differ", () => {
    printDaemonStatus(
      createStatus({
        cliVersion: "2026.4.23",
        cliEntrypoint: "/usr/local/bin/openclaw",
        rpcVersion: "2026.5.6",
      }),
      { json: false },
    );

    const output = humanOutput();
    expect(output).toContain("CLI version: 2026.4.23 (/usr/local/bin/openclaw)");
    expect(output).toContain("Gateway version: 2026.5.6");
    expect(output).toContain("this OpenClaw command is version 2026.4.23");
    expect(output).toContain(
      "if this mismatch is unexpected, update PATH so `openclaw` points to the version you want",
    );
  });

  it("prints gateway version from gathered gateway status when probe server metadata is absent", () => {
    printDaemonStatus(
      createStatus({
        cliVersion: "2026.4.23",
        cliEntrypoint: "/usr/local/bin/openclaw",
        gatewayVersion: "2026.5.7",
      }),
      { json: false },
    );

    const output = humanOutput();
    expect(output).toContain("Gateway version: 2026.5.7");
    expect(output).toContain("this OpenClaw command is version 2026.4.23");
  });

  it("reports the installed service version when the Gateway never reported one", () => {
    printDaemonStatus(
      createStatus({
        cliVersion: "2026.6.35",
        cliEntrypoint: "/home/ops/.local/bin/openclaw",
        layout: {
          execStart:
            "/usr/bin/node /home/ops/.npm-global/lib/node_modules/openclaw/dist/index.js gateway",
          packageRoot: "/home/ops/.npm-global/lib/node_modules/openclaw",
          packageVersion: "2026.4.15",
        },
      }),
      { json: false },
    );

    const output = humanOutput();
    expect(output).toContain("Gateway service version: 2026.4.15");
    expect(output).toContain(".npm-global/lib/node_modules/openclaw");
    expect(output).toContain("the installed Gateway service is version 2026.4.15");
    expect(output).toContain("The Gateway did not report its own version");
  });

  it("does not warn about the service install when it matches the CLI version", () => {
    printDaemonStatus(
      createStatus({
        cliVersion: "2026.6.35",
        cliEntrypoint: "/home/ops/.local/bin/openclaw",
        layout: {
          execStart:
            "/usr/bin/node /home/ops/.local/lib/node_modules/openclaw/dist/index.js gateway",
          packageRoot: "/home/ops/.local/lib/node_modules/openclaw",
          packageVersion: "2026.6.35",
        },
      }),
      { json: false },
    );

    const output = humanOutput();
    expect(output).toContain("Gateway service version: 2026.6.35");
    expect(output).not.toContain("installed Gateway service is version");
  });
});
