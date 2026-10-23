import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "../plugin-sdk/plugin-state-test-runtime.js";
import {
  finalizeRetiredPhoneControlCleanup,
  prepareRetiredPhoneControlCleanup,
} from "./doctor-retired-phone-control.js";

const seedDeny = [
  "camera.snap",
  "camera.clip",
  "screen.record",
  "computer.act",
  "mobile.ui.observe",
  "mobile.ui.act",
  "contacts.add",
  "calendar.add",
  "reminders.add",
  "sms.send",
  "sms.search",
  "health.summary",
] as const;

let stateDir = "";
let env: NodeJS.ProcessEnv;

function createLeaseJournal() {
  return createPluginStateKeyedStoreForTests<Record<string, unknown>>("phone-control", {
    namespace: "armed",
    maxEntries: 1,
    overflowPolicy: "reject-new",
    env,
  });
}

async function registerLease(overrides: Record<string, unknown>) {
  const store = createLeaseJournal();
  await store.register("generation-1", {
    version: 3,
    generation: "generation-1",
    phase: "active",
    armedAtMs: 1,
    expiresAtMs: 2,
    group: "writes",
    armedCommands: ["sms.send"],
    addedToAllow: [],
    removedFromDeny: [],
    persistentAllows: [],
    ...overrides,
  });
  return store;
}

function config(
  commands: NonNullable<NonNullable<OpenClawConfig["gateway"]>["nodes"]>["commands"],
): OpenClawConfig {
  return { gateway: { nodes: { commands } } };
}

async function writeLegacy(value: unknown) {
  const legacyPath = path.join(stateDir, "plugins", "phone-control", "armed.json");
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, JSON.stringify(value));
  return legacyPath;
}

beforeEach(async () => {
  resetPluginStateStoreForTests();
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-phone-control-retire-"));
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
  await fs.rm(stateDir, { recursive: true, force: true });
});

it("does not expose an allow that was effective only because a lease removed the seed deny", async () => {
  await registerLease({ removedFromDeny: ["sms.send"] });
  const cfg = config({
    allow: ["sms.send"],
    deny: seedDeny.filter((command) => command !== "sms.send"),
  });

  const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

  expect(result.config.gateway?.nodes?.commands).toBeUndefined();
  expect(result.configChanges).toEqual([
    "Removed stale Phone Control lease-only command allow entries.",
    "Removed the retired Phone Control setup deny seed.",
  ]);
});

it("prefers the authoritative SQLite journal over a stale legacy source", async () => {
  await registerLease({ addedToAllow: ["sms.send"], persistentAllows: ["health.summary"] });
  await writeLegacy({ version: 2, addedToAllow: ["health.summary"] });
  const cfg = config({ allow: ["sms.send", "health.summary"] });

  const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

  expect(result.config.gateway?.nodes?.commands?.allow).toEqual(["health.summary"]);
  expect(result.cleanupSafe).toBe(true);
});

it("keeps exact-seed entries that currently shadow explicit allows", async () => {
  const cfg = config({ allow: ["sms.send"], deny: [...seedDeny] });

  const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

  expect(result.config.gateway?.nodes?.commands).toEqual({
    allow: ["sms.send"],
    deny: ["sms.send"],
  });
  expect(result.configChanges).toEqual(["Removed the retired Phone Control setup deny seed."]);
});

it.each(["legacy", "canonical", "unreadable"] as const)(
  "preserves policy for malformed %s journals",
  async (source) => {
    if (source === "legacy") {
      await writeLegacy({ version: 3 });
    } else if (source === "canonical") {
      await createLeaseJournal().register("generation-1", { version: 3 });
    } else {
      vi.spyOn(fs, "stat").mockRejectedValueOnce(
        Object.assign(new Error("denied"), { code: "EACCES" }),
      );
    }
    const cfg = config({
      deny: [...seedDeny],
      ...(source === "legacy" ? { allow: ["sms.send"] } : {}),
    });
    const result = await prepareRetiredPhoneControlCleanup({ cfg, env });
    expect(result.config).toBe(cfg);
    expect(result.cleanupSafe).toBe(false);
    if (source === "legacy") {
      expect(result.configChanges).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    } else {
      expect(result.cleanupPending).toBe(true);
      if (source === "canonical") {
        expect(result.warnings).toEqual([
          "Retired Phone Control lease journal contains a malformed record.",
        ]);
      } else {
        expect(result.warnings[0]).toContain("Could not inspect retired Phone Control lease state");
      }
    }
  },
);

it("preserves policy and original bytes for malformed UTF-8 legacy journals", async () => {
  const legacyPath = await writeLegacy({
    version: 1,
    armedAtMs: 1,
    expiresAtMs: null,
    removedFromDeny: ["CORRUPT"],
  });
  const bytes = Buffer.from(
    (await fs.readFile(legacyPath, "utf8")).replace("CORRUPT", "\x80"),
    "latin1",
  );
  await fs.writeFile(legacyPath, bytes);
  const cfg = config({ deny: ["operator.command"] });

  const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

  expect(result.config).toBe(cfg);
  expect(result.cleanupSafe).toBe(false);
  expect(result.configChanges).toEqual([]);
  expect(result.warnings).toEqual([expect.stringContaining("must be valid UTF-8")]);
  expect(await fs.readFile(legacyPath)).toEqual(bytes);
});

it("does not touch operator-authored command entries that differ from the old seed", async () => {
  const deny = [...seedDeny, "custom.command"];
  const cfg = config({ allow: ["sms.send"], deny });

  const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

  expect(result.config).toBe(cfg);
  expect(result.config.gateway?.nodes?.commands).toEqual({ allow: ["sms.send"], deny });
  expect(result.configChanges).toEqual([]);
});

it("restores journal-owned deny entries without removing customized operator policy", async () => {
  await registerLease({ removedFromDeny: ["computer.act"] });
  const deny = ["camera.snap", "custom.command"];
  const cfg = config({ deny });

  const result = await prepareRetiredPhoneControlCleanup({ cfg, env });

  expect(result.config.gateway?.nodes?.commands?.deny).toEqual([
    "camera.snap",
    "custom.command",
    "computer.act",
  ]);
  expect(result.configChanges).toEqual([
    "Restored command deny entries removed by Phone Control leases.",
  ]);
});

it.each([false, true])(
  "finalizes journals only after legacy archival (blocked=%s)",
  async (blocked) => {
    const store = await registerLease({ addedToAllow: ["sms.send"] });
    const legacyPath = await writeLegacy({ version: 2, addedToAllow: ["camera.snap"] });
    if (blocked) {
      await fs.mkdir(`${legacyPath}.migrated`);
    }
    const result = await finalizeRetiredPhoneControlCleanup({ env });
    expect(result.warnings).toHaveLength(blocked ? 1 : 0);
    if (blocked) {
      await expect(store.entries()).resolves.toHaveLength(1);
      await fs.access(legacyPath);
    } else {
      expect(result.changes).toHaveLength(2);
      await expect(store.entries()).resolves.toEqual([]);
      await expect(fs.access(legacyPath)).rejects.toThrow();
      await fs.access(`${legacyPath}.migrated`);
    }
  },
);
