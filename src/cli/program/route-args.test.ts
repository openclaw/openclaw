import { describe, expect, it } from "vitest";
import {
  parseAgentsListRouteArgs,
  parseChannelsListRouteArgs,
  parseChannelsStatusRouteArgs,
  parseConfigGetRouteArgs,
  parseConfigUnsetRouteArgs,
  parseGatewayHealthRouteArgs,
  parseGatewayStatusRouteArgs,
  parseHealthRouteArgs,
  parseModelsListRouteArgs,
  parseModelsStatusRouteArgs,
  parseSessionsRouteArgs,
  parseStatusRouteArgs,
} from "./route-args.js";

const argv = (command: string) => ["node", "openclaw", ...command.split(" ")];
const healthOptions = { json: true, verbose: false, timeoutMs: 5000 };

describe("route-args", () => {
  it("parses health and status route args", () => {
    expect(parseHealthRouteArgs(argv("health --json --timeout 5000"))).toEqual(healthOptions);
    expect(
      parseStatusRouteArgs(argv("status --json --deep --all --usage --agent beta --timeout 5000")),
    ).toEqual({
      json: true,
      deep: true,
      all: true,
      usage: true,
      agent: "beta",
      verbose: false,
      timeoutMs: 5000,
    });
    expect(parseStatusRouteArgs(argv("status --timeout"))).toBeNull();
    expect(parseStatusRouteArgs(argv("status --agent"))).toBeNull();
  });

  it("defers status/health --timeout with a present-but-invalid value to Commander", () => {
    // Invalid values must not silently fall back to the default timeout.
    for (const bad of ["0", "-5", "nope", "5s"]) {
      expect(parseStatusRouteArgs(argv(`status --timeout ${bad}`))).toBeNull();
      expect(parseHealthRouteArgs(argv(`health --timeout ${bad}`))).toBeNull();
    }
    expect(parseStatusRouteArgs(argv("status --timeout 5000 --timeout nope"))).toBeNull();
    expect(parseHealthRouteArgs(argv("health --timeout nope --timeout 5000"))).toMatchObject({
      timeoutMs: 5000,
    });
    expect(parseStatusRouteArgs(argv("status --timeout 5000"))).toMatchObject({ timeoutMs: 5000 });
    expect(parseStatusRouteArgs(argv("status"))).toMatchObject({ timeoutMs: undefined });
  });

  it("defers command options placed before status or health to Commander", () => {
    expect(parseStatusRouteArgs(argv("--json status"))).toBeNull();
    expect(parseHealthRouteArgs(argv("--json health"))).toBeNull();
    expect(parseHealthRouteArgs(argv("--verbose health"))).toBeNull();
    expect(parseHealthRouteArgs(argv("--timeout=5000 health"))).toBeNull();
    expect(parseHealthRouteArgs(argv("--timeout 5000 health"))).toBeNull();
    expect(parseStatusRouteArgs(argv("--profile work status --json"))).toMatchObject({
      json: true,
    });
  });

  it.each([
    {
      name: "sessions flag terminator",
      parse: parseSessionsRouteArgs,
      args: argv("sessions -- --json"),
    },
    {
      name: "agents list stray positional",
      parse: parseAgentsListRouteArgs,
      args: argv("agents list extra"),
    },
    {
      name: "config unset empty excess operand",
      parse: parseConfigUnsetRouteArgs,
      args: ["node", "openclaw", "config", "unset", "gateway.port", "", "--dry-run"],
    },
  ])("defers unsupported routed argv: $name", ({ parse, args }) => {
    expect(parse(args)).toBeNull();
  });

  it("preserves equals forms and root options on routed argv", () => {
    expect(parseHealthRouteArgs(argv("--profile work health --timeout=5000 --json"))).toEqual(
      healthOptions,
    );
    expect(parseSessionsRouteArgs(argv("sessions --agent=default --limit=25"))).toMatchObject({
      agent: "default",
      limit: "25",
    });
    expect(parseAgentsListRouteArgs(argv("--log-level=debug agents list --json"))).toEqual({
      json: true,
      bindings: false,
      tree: false,
    });
    expect(parseAgentsListRouteArgs(argv("agents --json --bindings"))).toEqual({
      json: true,
      bindings: true,
      tree: false,
    });
  });

  it("parses gateway status route args and rejects probe-only ssh flags", () => {
    expect(
      parseGatewayStatusRouteArgs(
        argv(
          "gateway status --url ws://127.0.0.1:18789 --token abc --password def --timeout 5000 --deep --require-rpc --json",
        ),
      ),
    ).toEqual({
      rpc: { url: "ws://127.0.0.1:18789", token: "abc", password: "def", timeout: "5000" },
      probe: true,
      requireRpc: true,
      deep: true,
      json: true,
    });
    expect(parseGatewayStatusRouteArgs(argv("gateway status --ssh host"))).toBeNull();
    expect(parseGatewayStatusRouteArgs(argv("gateway status --ssh-auto"))).toBeNull();
  });

  it("parses JSON gateway health route args and defers unsupported shapes", () => {
    expect(
      parseGatewayHealthRouteArgs(
        argv(
          "gateway health --url ws://127.0.0.1:18789 --token abc --password def --timeout 5000 --expect-final --json",
        ),
      ),
    ).toEqual({
      rpc: {
        url: "ws://127.0.0.1:18789",
        token: "abc",
        password: "def",
        timeout: "5000",
        expectFinal: true,
        json: true,
      },
      localPortOverride: undefined,
    });
    expect(parseGatewayHealthRouteArgs(argv("gateway --port 19083 health --json"))).toEqual({
      rpc: {
        url: undefined,
        token: undefined,
        password: undefined,
        timeout: "10000",
        expectFinal: false,
        json: true,
      },
      localPortOverride: 19083,
    });
    expect(parseGatewayHealthRouteArgs(argv("gateway health"))).toBeNull();
    expect(
      parseGatewayHealthRouteArgs(
        argv("gateway health --url ws://127.0.0.1:18789 --port 19083 --json"),
      ),
    ).toBeNull();
    expect(parseGatewayHealthRouteArgs(argv("gateway health --timeout 5s --json"))).toBeNull();
  });

  it("parses config routes", () => {
    expect(
      parseConfigGetRouteArgs(argv("--log-level debug config get update.channel --json")),
    ).toEqual({
      path: "update.channel",
      json: true,
    });
    expect(parseConfigUnsetRouteArgs(argv("config unset --profile work update.channel"))).toEqual({
      path: "update.channel",
      cliOptions: { dryRun: false, allowExec: false, json: false },
    });
    expect(
      parseConfigUnsetRouteArgs(argv("config unset --dry-run --json --allow-exec update.channel")),
    ).toEqual({
      path: "update.channel",
      cliOptions: { dryRun: true, allowExec: true, json: true },
    });
    expect(parseConfigGetRouteArgs(argv("config get --json"))).toBeNull();
  });

  it("parses models list and models status route args", () => {
    expect(
      parseModelsListRouteArgs(argv("models list --provider openai --all --local --json --plain")),
    ).toEqual({
      provider: "openai",
      all: true,
      local: true,
      json: true,
      plain: true,
    });
    expect(
      parseModelsStatusRouteArgs(
        argv(
          "models status --probe-provider openai --probe-timeout 5000 --probe-concurrency 2 --probe-max-tokens 64 --probe-profile fast --probe-profile safe --agent default --json --plain --check --probe",
        ),
      ),
    ).toEqual({
      probeProvider: "openai",
      probeTimeout: "5000",
      probeConcurrency: "2",
      probeMaxTokens: "64",
      probeProfile: ["fast", "safe"],
      agent: "default",
      json: true,
      plain: true,
      check: true,
      probe: true,
    });
    expect(parseModelsStatusRouteArgs(argv("models status --probe-profile"))).toBeNull();
  });

  it.each([
    { name: "gateway status", parse: parseGatewayStatusRouteArgs },
    { name: "models list", parse: parseModelsListRouteArgs },
    { name: "channels list", parse: parseChannelsListRouteArgs },
    { name: "channels status", parse: parseChannelsStatusRouteArgs },
  ])("defers unknown options for sibling routed parser: $name", ({ parse, name }) => {
    expect(parse(argv(`${name} --wat`))).toBeNull();
  });
});
