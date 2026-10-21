import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import {
  readChannelPairingStateSnapshot as readPairing,
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

function accounts(accountIds: Record<string, string[]>, configuredChannelIds: string[] = []) {
  return { configuredChannelIds, resolveAccounts: () => ({ accountIds }) };
}

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
    fs.writeFileSync(
      path.join(sourceDir, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  const detected = detectLegacyChannelPairingState({ sourceDir, ...options });
  return {
    env,
    sourceDir,
    detected,
    migrate: () => migrateLegacyChannelPairingState({ detected, env }),
    read: (name: string) => fs.readFileSync(path.join(sourceDir, name), "utf8"),
    exists: (name: string) => fs.existsSync(path.join(sourceDir, name)),
  };
}

function expectPreserved(
  state: Awaited<ReturnType<typeof fixture>>,
  names: string[],
  reason: "ambiguous" | "unresolved",
) {
  const warnings = names.map((name) =>
    expect.stringContaining(
      `Legacy channel allowFrom channel/account is ${reason}; left in place at ${path.join(state.sourceDir, name)}`,
    ),
  );
  const result = state.migrate();
  expect(result).toEqual({ changes: [], warnings: expect.arrayContaining(warnings) });
  expect(result.warnings).toHaveLength(names.length);
  expect(names.every(state.exists)).toBe(true);
}

it.each([
  { removedMalformed: false, configuredMalformed: false },
  { removedMalformed: true, configuredMalformed: false },
  { removedMalformed: false, configuredMalformed: true },
])(
  "archives removed accounts: $removedMalformed / $configuredMalformed",
  async ({ removedMalformed, configuredMalformed }) => {
    const filename = "custom-channel-removed-allowFrom.json";
    const configuredFilename = "custom-channel-active-allowFrom.json";
    const original = removedMalformed ? "{broken\n" : '["former-user"]\n';
    const state = await fixture(
      {
        [filename]: original,
        [`${filename}.migrated`]: original,
        ...(configuredMalformed ? { [configuredFilename]: "{broken\n" } : {}),
      },
      accounts({ "custom-channel": ["active"] }, ["custom-channel"]),
    );
    const source = path.join(state.sourceDir, filename);
    const laterRepair = vi.fn(() => ({ changes: ["Later repair completed"], warnings: [] }));
    const result = await runLegacyStateMigrationSteps(
      [state.migrate, laterRepair].map((run, index) => ({
        id: index === 0 ? "channel-pairing" : "later-repair",
        run,
        phase: "final" as const,
        source: [],
        target: [],
        requiredness: "required" as const,
        reversibility: "checkpoint-required" as const,
      })),
    );
    expect(result.receipts.map((receipt) => receipt.outcome)).toEqual(
      configuredMalformed ? ["refused", "refused"] : ["warning", "completed"],
    );
    expect(laterRepair).toHaveBeenCalledTimes(configuredMalformed ? 0 : 1);
    const warnings = result.receipts[0]?.warnings.join("\n");
    expect(warnings).toContain(source);
    expect(warnings).toContain(`${source}.migrated.2`);
    expect(state.exists(filename)).toBe(false);
    expect([state.read(`${filename}.migrated`), state.read(`${filename}.migrated.2`)]).toEqual([
      original,
      original,
    ]);
    if (configuredMalformed) {
      expect(state.read(configuredFilename)).toBe("{broken\n");
    }
    expect(readPairing("custom-channel", state.env).allowFrom).toEqual({});
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
    accounts({ telegram: ["*", "alerts", "ops/bot", "ops_bot"] }),
  );
  expect(state.detected.hasLegacy).toBe(true);
  const result = state.migrate();
  expect(result.warnings).toEqual([]);
  expect(result.changes).toHaveLength(4);
  expect(fs.readdirSync(state.sourceDir)).toEqual([]);
  expect(readPairing("telegram", state.env)).toEqual({
    version: 1,
    requests: [request],
    allowFrom: { default: ["1001"], alerts: ["1002"], ops_bot: ["1003"] },
  });
  expect(fs.existsSync(path.join(path.dirname(state.sourceDir), "state", "openclaw.sqlite"))).toBe(
    true,
  );
});

it("imports a built-in explicit default account without channel config", async () => {
  const allowFrom = ["+12025550101", "+12025550102", "+12025550103"];
  const state = await fixture({ "whatsapp-default-allowFrom.json": { version: 1, allowFrom } });
  expect(state.migrate()).toEqual({
    warnings: [],
    changes: ["Migrated 3 whatsapp/default allowFrom entries → shared SQLite state"],
  });
  expect(fs.readdirSync(state.sourceDir)).toEqual([]);
  expect(readPairing("whatsapp", state.env).allowFrom).toEqual({ default: allowFrom });
});

it("merges authoritative SQLite rows and keeps unreadable sources", async () => {
  const state = await fixture(
    {
      "custom-channel-primary-allowFrom.json": { version: 1, allowFrom: ["imported"] },
      "custom-channel-pairing.json": "{broken\n",
    },
    accounts({ "custom-channel": ["primary"] }, ["custom-channel"]),
  );
  writeChannelPairingStateSnapshot(
    "custom-channel",
    { version: 1, requests: [request], allowFrom: { primary: ["kept"] } },
    state.env,
  );
  expect(state.migrate().warnings).toEqual([
    expect.stringContaining("Legacy channel pairing file unreadable; left in place"),
  ]);
  expect(fs.readdirSync(state.sourceDir)).toEqual(["custom-channel-pairing.json"]);
  expect(readPairing("custom-channel", state.env)).toEqual({
    version: 1,
    requests: [request],
    allowFrom: { primary: ["kept", "imported"] },
  });
});

it("leaves case-folded filename collision sets in place", async () => {
  const names = ["Ab", "AB", "xy", "Xy"].map((account) => `telegram-${account}-allowFrom.json`);
  const state = await fixture(
    Object.fromEntries(
      names.map((name, index) => [name, { version: 1, allowFrom: [`user-${index}`] }]),
    ),
    accounts({ telegram: ["ab", "xy"] }),
  );
  const marker = path.join(state.sourceDir, "case-check");
  fs.writeFileSync(marker, "case");
  const caseSensitive = !fs.existsSync(path.join(state.sourceDir, "CASE-CHECK"));
  fs.rmSync(marker);
  if (!caseSensitive) {
    expect(caseSensitive).toBe(false);
    return;
  }
  expectPreserved(state, names, "ambiguous");
  expect(readPairing("telegram", state.env).allowFrom).toEqual({});
});

it.each<[string, Record<string, string[]>, string[], "unresolved" | "ambiguous"]>([
  ["telegram-ops..bot", { telegram: ["ops_bot"] }, [], "unresolved"],
  ["telegram-DEFAULT", { telegram: ["default"] }, [], "unresolved"],
  ["custom-channel-default", { telegram: [] }, ["custom-channel"], "unresolved"],
  ["telegram-business", { telegram: ["business"] }, ["telegram-business"], "ambiguous"],
  [
    "telegram-business-ops..bot",
    { telegram: [], "telegram-business": ["ops_bot"] },
    ["telegram-business"],
    "unresolved",
  ],
])("preserves account source %s", async (stem, accountIds, configuredChannelIds, reason) => {
  const filename = `${stem}-allowFrom.json`;
  const state = await fixture(
    { [filename]: { version: 1, allowFrom: ["1003"] } },
    accounts(accountIds, configuredChannelIds),
  );
  expectPreserved(state, [filename], reason);
  for (const channel of new Set([...Object.keys(accountIds), ...configuredChannelIds])) {
    expect(readPairing(channel, state.env).allowFrom).toEqual({});
  }
});
