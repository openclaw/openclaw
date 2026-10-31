import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { ChannelsStatusResult } from "../../packages/gateway-protocol/src/schema/channels.js";
import { sendMinimalGatewayResponse } from "../gateway/minimal-gateway.test-helpers.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  prepareGatewayCliFixture,
  prepareUnreachableGatewayCliFixture,
  runIsolatedGatewayCli,
  seedDeviceAuth,
  snapshotDirectoryContents,
  snapshotSharedStateArtifacts,
  tempDirs,
  UNREACHABLE_GATEWAY_URL,
} from "./gateway-backed-exit.process.test-support.js";
import {
  expectCliResult,
  startGateway,
  startRateLimitedGateway,
} from "./gateway-backed-exit.test-helpers.js";

function expectUnreachableGatewayTransportFailure(
  result: Awaited<ReturnType<typeof runIsolatedGatewayCli>>,
  output: "json" | "text",
): void {
  expect(result).toMatchObject({ code: 1, signal: null });
  if (output === "json") {
    expect(expectCliResult(result, 1)).toMatchObject({
      ok: false,
      error: {
        type: "gateway_transport_error",
        kind: "closed",
        message: expect.stringContaining("Gateway not reachable"),
      },
      gateway: { url: UNREACHABLE_GATEWAY_URL },
    });
    return;
  }
  expect(result.stderr).toBe(
    "Couldn't connect to OpenClaw.\n" +
      "Check the Control UI or run `openclaw gateway status` in your terminal.\n",
  );
}

// This real-child custody proof includes SQLite auth startup; call.test.ts owns deadline timing.
const STATE_CUSTODY_RPC_BUDGET_MS = 10_000;
const CHANNEL_PROBE_TIMEOUT_MS = 2_000;

it.each<[string, string[]]>([
  ["channels.status", ["channels", "status", "--probe"]],
  ["system.info", ["gateway", "call", "system.info"]],
  [
    "channels.status",
    [
      "gateway",
      "call",
      "channels.status",
      "--params",
      JSON.stringify({ probe: true, timeoutMs: CHANNEL_PROBE_TIMEOUT_MS }),
    ],
  ],
])("reads %s through %j while another process owns state maintenance", async (method, args) => {
  const root = tempDirs.make("openclaw-status-state-custody-");
  let stateOwner: ReturnType<typeof acquireGatewayStateOwner> | undefined;
  let close: (() => Promise<void>) | undefined;
  try {
    const gateway = await startGateway(
      (ws, frame) => {
        stateOwner!.assertCurrent();
        expect(frame.method).toBe(method);
        if (method === "channels.status") {
          const timeoutMs = frame.params?.timeoutMs;
          expect(frame.params).toEqual({ probe: true, timeoutMs });
          expect(Number.isInteger(timeoutMs)).toBe(true);
          expect(timeoutMs).toBeGreaterThan(0);
          expect(timeoutMs).toBeLessThanOrEqual(STATE_CUSTODY_RPC_BUDGET_MS);
          if (args[0] === "gateway") {
            expect(timeoutMs).toBe(CHANNEL_PROBE_TIMEOUT_MS);
          }
        }
        sendMinimalGatewayResponse(ws, frame.id, payload);
      },
      (frame) => {
        expect(frame.params?.auth).toEqual({ deviceToken: "synthetic-stored-device-token" });
        expect(frame.params?.device).toMatchObject({ id: identity.deviceId, nonce: "test-nonce" });
        // Acquire custody only after auth loading, before hello can trigger any writes.
        stateOwner ??= acquireGatewayStateOwner({
          databasePath: resolveOpenClawStateSqlitePath(env),
        });
        const ownerPath = path.relative(canonicalStateDir, stateOwner.path);
        if (
          ownerPath &&
          ownerPath !== ".." &&
          !ownerPath.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(ownerPath)
        ) {
          expectedAfter[ownerPath] =
            `file:${createHash("sha256").update(readFileSync(stateOwner.path)).digest("hex")}`;
          for (
            let directory = path.dirname(ownerPath);
            directory !== ".";
            directory = path.dirname(directory)
          ) {
            expectedAfter[directory] ??= "directory";
          }
        }
        return {
          methods: [method],
          auth: {
            role: "operator",
            scopes: ["operator.read"],
            deviceToken: "synthetic-issued-device-token",
          },
        };
      },
    );
    close = gateway.close;
    const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
      mode: "remote",
      auth: { mode: "none" },
      remote: { url: gateway.url },
    });
    const { identity, env } = await seedDeviceAuth(
      root,
      stateDir,
      gateway.url,
      "synthetic-stored-device-token",
    );
    const expectedAfter = await snapshotDirectoryContents(stateDir);
    const canonicalStateDir = await fs.realpath(stateDir);
    const payload =
      method === "channels.status"
        ? ({
            ts: 1_800_000_000_000,
            channelOrder: [],
            channelLabels: {},
            channels: {},
            channelAccounts: {},
            channelDefaultAccountId: {},
          } satisfies ChannelsStatusResult)
        : { pid: 123, runtimeVersion: "synthetic-runtime" };
    const result = await runIsolatedGatewayCli({
      args: [...args, "--json", "--timeout", String(STATE_CUSTODY_RPC_BUDGET_MS)],
      root,
      stateDir,
      configPath,
    });
    expect(expectCliResult(result)).toEqual(payload);
    expect(gateway.calls).toEqual([method]);
    stateOwner!.assertCurrent();
    expect(await snapshotDirectoryContents(stateDir)).toEqual(expectedAfter);
  } finally {
    try {
      stateOwner?.release();
    } finally {
      await close?.();
    }
  }
});

// Keep absent and seeded state for each real command entry point.
it.each(
  (
    [
      ["root-health-json", ["health"], "json"],
      ["gateway-health-text", ["gateway", "health"], "text"],
      ["gateway-health-json", ["gateway", "health"], "json"],
      ["gateway-suspend-json", ["gateway", "suspend"], "json"],
      ["gateway-resume-json", ["gateway", "resume", "suspension-1"], "json"],
    ] satisfies Array<[string, string[], "json" | "text"]>
  ).flatMap(([label, command, output]) =>
    [false, true].map((seeded) => ({
      label,
      output,
      seeded,
      args: [...command, ...(output === "json" ? ["--json"] : []), "--timeout", "250"],
    })),
  ),
)(
  "leaves shared state byte-identical after unreachable $label (seeded=$seeded)",
  async ({ label, args, output, seeded }) => {
    const fixture = await prepareUnreachableGatewayCliFixture({
      label,
      seeded,
    });
    const before = await snapshotSharedStateArtifacts(fixture.stateDir);
    expect(Object.keys(before).includes("openclaw.sqlite")).toBe(seeded);

    const result = await runIsolatedGatewayCli({ ...fixture, args });

    expectUnreachableGatewayTransportFailure(result, output);
    expect(await snapshotSharedStateArtifacts(fixture.stateDir)).toEqual(before);
  },
);

it("keeps gateway auth failures machine-readable through the real health entry point", async () => {
  const root = tempDirs.make("openclaw-gateway-auth-json-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const port = await getFreePort();
  await fs.mkdir(stateDir, { recursive: true });

  const result = await runIsolatedGatewayCli({
    args: ["health", "--json", "--timeout", "250"],
    root,
    stateDir,
    configPath,
    env: { OPENCLAW_GATEWAY_PORT: String(port) },
  });

  expect(expectCliResult(result, 1)).toMatchObject({
    ok: false,
    error: {
      type: "gateway_credentials_required",
      message: expect.stringContaining("requires"),
    },
  });
});

it("preserves pre-hello rate-limit details through the real health entry point", async () => {
  const root = tempDirs.make("openclaw-gateway-rate-limit-json-");
  const gateway = await startRateLimitedGateway();
  const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
    mode: "remote",
    remote: { url: gateway.url, token: "test-token" },
  });

  const result = await runIsolatedGatewayCli({
    args: ["health", "--json", "--timeout", "2000"],
    root,
    stateDir,
    configPath,
  });

  expect(expectCliResult(result, 1)).toEqual({
    ok: false,
    error: {
      type: "gateway_request_error",
      code: "AUTH_RATE_LIMITED",
      message:
        "Gateway authentication is temporarily rate-limited. Wait for the temporary lockout to expire, then retry.",
      retryable: true,
      retryAfterMs: 60_000,
    },
    gateway: { reachable: true },
  });
  expect(result.stdout).not.toContain("gateway.remote.token");
  expect(result.stdout).not.toContain("devices rotate");
});
