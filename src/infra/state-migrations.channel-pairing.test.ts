import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import {
  readChannelPairingStateSnapshot,
  writeChannelPairingStateSnapshot,
} from "../pairing/pairing-store-sqlite.test-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  detectLegacyChannelPairingState,
  migrateLegacyChannelPairingState,
} from "./state-migrations.channel-pairing.js";
import { runLegacyStateMigrationSteps } from "./state-migrations.steps.js";

const tempDirs = createTrackedTempDirs();
const createdAt = "2026-01-01T00:00:00.000Z";
const request = {
  id: "pending-user",
  code: "PAIRME12",
  createdAt,
  lastSeenAt: createdAt,
  meta: { accountId: "alerts" },
};
type DetectionOptions = Omit<Parameters<typeof detectLegacyChannelPairingState>[0], "sourceDir">;

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

async function fixture(files: Record<string, unknown>, options: DetectionOptions = {}) {
  const stateDir = await tempDirs.make("openclaw-pairing-migration-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sourceDir = resolveOAuthDir(env, stateDir);
  fs.mkdirSync(sourceDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(sourceDir, name), JSON.stringify(value));
  }
  const detected = detectLegacyChannelPairingState({ sourceDir, ...options });
  return {
    env,
    sourceDir,
    detected,
    migrate: () => migrateLegacyChannelPairingState({ detected, env }),
  };
}

describe("legacy channel pairing state migration", () => {
  it.each([
    { removedMalformed: false, configuredMalformed: false },
    { removedMalformed: true, configuredMalformed: false },
    { removedMalformed: false, configuredMalformed: true },
  ])(
    "archives removed account state (malformed: $removedMalformed, configured malformed file: $configuredMalformed)",
    async ({ removedMalformed, configuredMalformed }) => {
      const filename = "custom-channel-removed-allowFrom.json";
      const state = await fixture(
        {
          [filename]: ["former-user"],
          ...(configuredMalformed ? { "custom-channel-active-allowFrom.json": null } : {}),
        },
        {
          configuredChannelIds: ["custom-channel"],
          resolveAccounts: () => ({ accountIds: { "custom-channel": ["active"] } }),
        },
      );
      const source = path.join(state.sourceDir, filename);
      const original = removedMalformed ? "{broken\n" : '["former-user"]\n';
      fs.writeFileSync(source, original);
      fs.writeFileSync(`${source}.migrated`, original);
      const configuredSource = path.join(state.sourceDir, "custom-channel-active-allowFrom.json");
      if (configuredMalformed) {
        fs.writeFileSync(configuredSource, "{broken\n");
      }
      const laterRepair = vi.fn(() => ({ changes: ["Later repair completed"], warnings: [] }));
      const result = await runLegacyStateMigrationSteps(
        [
          { id: "channel-pairing", run: state.migrate },
          { id: "later-repair", run: laterRepair },
        ].map((step) =>
          Object.assign(step, {
            phase: "final" as const,
            source: [],
            target: [],
            requiredness: "required" as const,
            reversibility: "checkpoint-required" as const,
          }),
        ),
      );
      expect(result.receipts.map((receipt) => receipt.outcome)).toEqual(
        configuredMalformed ? ["refused", "refused"] : ["warning", "completed"],
      );
      expect(laterRepair).toHaveBeenCalledTimes(configuredMalformed ? 0 : 1);
      const warnings = result.receipts[0]?.warnings.join("\n");
      expect(warnings).toContain(source);
      expect(warnings).toContain(`${source}.migrated.2`);
      expect(fs.existsSync(source)).toBe(false);
      expect(fs.readFileSync(`${source}.migrated`, "utf8")).toBe(original);
      expect(fs.readFileSync(`${source}.migrated.2`, "utf8")).toBe(original);
      if (configuredMalformed) {
        expect(fs.readFileSync(configuredSource, "utf8")).toBe("{broken\n");
      }
      expect(readChannelPairingStateSnapshot("custom-channel", state.env).allowFrom).toEqual({});
    },
  );

  it("defers configured account discovery without resolving accounts", async () => {
    const resolveAccounts = vi.fn(() => ({ defaultAccountIds: { "custom-channel": "primary" } }));
    const { detected } = await fixture(
      { "custom-channel-allowFrom.json": ["legacy-user"] },
      {
        configuredChannelIds: ["custom-channel"],
        resolveAccounts,
        deferConfiguredAccountDiscovery: true,
      },
    );
    expect(detected.accountDiscoveryDeferred).toBe(true);
    expect(resolveAccounts).not.toHaveBeenCalled();
  });

  it("does not defer pairing requests or built-in explicit default accounts", async () => {
    const { detected } = await fixture(
      {
        "telegram-pairing.json": { version: 1, requests: [] },
        "whatsapp-default-allowFrom.json": ["legacy-user"],
      },
      {
        configuredChannelIds: ["custom-channel", "whatsapp"],
        deferConfiguredAccountDiscovery: true,
      },
    );
    expect(detected.accountDiscoveryDeferred).toBe(false);
  });

  it("imports requests and exact scoped accounts while ignoring invalid candidates", async () => {
    const state = await fixture(
      {
        "telegram-pairing.json": { version: 1, requests: [request] },
        "telegram-allowFrom.json": { version: 1, allowFrom: ["1001", "1001", "*"] },
        "telegram-alerts-allowFrom.json": ["1002"],
        "telegram-Ops_Bot-allowFrom.json": ["1003"],
      },
      {
        resolveAccounts: () => ({
          accountIds: { telegram: ["*", "alerts", "ops/bot", "ops_bot"] },
        }),
      },
    );
    expect(state.detected.hasLegacy).toBe(true);
    const result = state.migrate();
    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(4);
    expect(fs.readdirSync(state.sourceDir)).toEqual([]);
    expect(readChannelPairingStateSnapshot("telegram", state.env)).toEqual({
      version: 1,
      requests: [request],
      allowFrom: { default: ["1001"], alerts: ["1002"], ops_bot: ["1003"] },
    });
    expect(
      fs.existsSync(path.join(path.dirname(state.sourceDir), "state", "openclaw.sqlite")),
    ).toBe(true);
  });

  it("imports a built-in explicit default account without channel config", async () => {
    const allowFrom = ["+12025550101", "+12025550102", "+12025550103"];
    const state = await fixture({ "whatsapp-default-allowFrom.json": { version: 1, allowFrom } });
    expect(state.migrate()).toEqual({
      warnings: [],
      changes: ["Migrated 3 whatsapp/default allowFrom entries → shared SQLite state"],
    });
    expect(fs.readdirSync(state.sourceDir)).toEqual([]);
    expect(readChannelPairingStateSnapshot("whatsapp", state.env).allowFrom).toEqual({
      default: allowFrom,
    });
  });

  it("merges authoritative SQLite rows and keeps unreadable sources", async () => {
    const state = await fixture(
      {
        "custom-channel-primary-allowFrom.json": { version: 1, allowFrom: ["imported"] },
        "custom-channel-pairing.json": null,
      },
      {
        configuredChannelIds: ["custom-channel"],
        resolveAccounts: () => ({ accountIds: { "custom-channel": ["primary"] } }),
      },
    );
    fs.writeFileSync(path.join(state.sourceDir, "custom-channel-pairing.json"), "{broken\n");
    writeChannelPairingStateSnapshot(
      "custom-channel",
      { version: 1, requests: [request], allowFrom: { primary: ["kept"] } },
      state.env,
    );
    expect(state.migrate().warnings).toEqual([
      expect.stringContaining("Legacy channel pairing file unreadable; left in place"),
    ]);
    expect(fs.readdirSync(state.sourceDir)).toEqual(["custom-channel-pairing.json"]);
    expect(readChannelPairingStateSnapshot("custom-channel", state.env)).toEqual({
      version: 1,
      requests: [request],
      allowFrom: { primary: ["kept", "imported"] },
    });
  });

  it("leaves case-folded filename collision sets in place", async () => {
    const names = [
      "telegram-AmbiguousAcct-allowFrom.json",
      "telegram-AMBIGUOUSACCT-allowFrom.json",
      "telegram-exactacct-allowFrom.json",
      "telegram-ExactAcct-allowFrom.json",
    ];
    const state = await fixture(
      {},
      { resolveAccounts: () => ({ accountIds: { telegram: ["ambiguousacct", "exactacct"] } }) },
    );
    const marker = path.join(state.sourceDir, "case-check");
    fs.writeFileSync(marker, "case");
    const caseSensitive = !fs.existsSync(path.join(state.sourceDir, "CASE-CHECK"));
    fs.rmSync(marker);
    if (!caseSensitive) {
      expect(caseSensitive).toBe(false);
      return;
    }
    for (const [index, name] of names.entries()) {
      fs.writeFileSync(
        path.join(state.sourceDir, name),
        JSON.stringify({ version: 1, allowFrom: [`user-${index}`] }),
      );
    }
    const result = migrateLegacyChannelPairingState({
      env: state.env,
      detected: detectLegacyChannelPairingState({
        sourceDir: state.sourceDir,
        resolveAccounts: () => ({ accountIds: { telegram: ["ambiguousacct", "exactacct"] } }),
      }),
    });
    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(names.length);
    expect(result.warnings).toEqual(
      expect.arrayContaining(
        names.map((name) =>
          expect.stringContaining(
            `Legacy channel allowFrom channel/account is ambiguous; left in place at ${path.join(state.sourceDir, name)}`,
          ),
        ),
      ),
    );
    expect(names.every((name) => fs.existsSync(path.join(state.sourceDir, name)))).toBe(true);
    expect(readChannelPairingStateSnapshot("telegram", state.env).allowFrom).toEqual({});
  });

  it.each<{
    filename: string;
    accountIds: Record<string, string[]>;
    configuredChannelIds: string[];
    channels: string[];
    reason: "unresolved" | "ambiguous";
  }>([
    {
      filename: "telegram-ops..bot-allowFrom.json",
      accountIds: { telegram: ["ops_bot"] },
      configuredChannelIds: [],
      channels: ["telegram"],
      reason: "unresolved",
    },
    {
      filename: "telegram-DEFAULT-allowFrom.json",
      accountIds: { telegram: ["default"] },
      configuredChannelIds: [],
      channels: ["telegram"],
      reason: "unresolved",
    },
    {
      filename: "custom-channel-default-allowFrom.json",
      accountIds: { telegram: [] },
      configuredChannelIds: ["custom-channel"],
      channels: ["custom-channel"],
      reason: "unresolved",
    },
    {
      filename: "telegram-business-allowFrom.json",
      accountIds: { telegram: ["business"] },
      configuredChannelIds: ["telegram-business"],
      channels: ["telegram", "telegram-business"],
      reason: "ambiguous",
    },
    {
      filename: "telegram-business-ops..bot-allowFrom.json",
      accountIds: { telegram: [], "telegram-business": ["ops_bot"] },
      configuredChannelIds: ["telegram-business"],
      channels: ["telegram", "telegram-business"],
      reason: "unresolved",
    },
  ])(
    "preserves $reason account source $filename",
    async ({ filename, accountIds, configuredChannelIds, channels, reason }) => {
      const state = await fixture(
        { [filename]: { version: 1, allowFrom: ["1003"] } },
        {
          configuredChannelIds,
          resolveAccounts: () => ({ accountIds }),
        },
      );
      expect(state.migrate()).toEqual({
        changes: [],
        warnings: [
          expect.stringContaining(
            `Legacy channel allowFrom channel/account is ${reason}; left in place`,
          ),
        ],
      });
      expect(fs.existsSync(path.join(state.sourceDir, filename))).toBe(true);
      for (const channel of channels) {
        expect(readChannelPairingStateSnapshot(channel, state.env).allowFrom).toEqual({});
      }
    },
  );
});
