import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { scanDoctorSessionEntriesTolerant } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note,
}));

import { repairLegacyDashboardChatTypes } from "./doctor-session-dashboard-chat-type.js";
import { createCanonicalRepairFixture } from "./doctor-session-repair-fixture.test-support.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const dashboardRootKey = (suffix: number, agentId = "main") =>
  `agent:${agentId}:dashboard:7d3c1f00-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const ROOT_KEY = dashboardRootKey(1);

// The durable shape v2026.10.6 wrote for a dashboard chat created without a message.
const legacyRoot = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "legacy-root",
  updatedAt: 1,
  createdVia: "operator",
  createdAt: 1,
  spawnDepth: 0,
  parentSessionKey: "agent:main:main",
  ...overrides,
});

const discordDelivery: SessionEntry["delivery"] = {
  kind: "external",
  route: { channel: "discord", accountId: "default", target: { to: "channel:1" } },
  context: { channel: "discord", accountId: "default", to: "channel:1" },
  origin: { provider: "discord", accountId: "default", to: "channel:1", chatType: "channel" },
};

function expectNote(verb: string) {
  expect(note).toHaveBeenCalledWith(
    expect.stringContaining(`${verb} 1 dashboard chat(s)`),
    "Session chat type",
  );
  note.mockClear();
}

function readEntries(fixture: ReturnType<typeof createCanonicalRepairFixture>) {
  const entries: Record<string, SessionEntry> = {};
  scanDoctorSessionEntriesTolerant(fixture.scope(), ({ entry, sessionKey }) => {
    entries[sessionKey] = entry;
  });
  return entries;
}

describe("doctor dashboard chat type backfill", () => {
  let state: OpenClawTestState | undefined;

  afterEach(async () => {
    note.mockClear();
    await state?.cleanup();
    state = undefined;
  });

  it("records only eligible dashboard roots as direct, and only under --fix", async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-doctor-dashboard-chat-type-" });
    const fixture = createCanonicalRepairFixture(state.stateDir);
    const config = fixture.cfg;
    const env = fixture.env;
    const exclusions: Partial<SessionEntry>[] = [
      { chatType: "group" },
      { createdVia: "channel" },
      { createdVia: "spawn" },
      { createdVia: undefined },
      { spawnedBy: "agent:main:main" },
      { forkSource: { sessionKey: ROOT_KEY, sessionId: "source" } },
      { pluginOwnerId: "workboard" },
      { incognito: true },
      { delivery: discordDelivery },
      { parentSessionKey: "agent:main:discord:group:1" },
      { parentSessionKey: undefined },
    ];
    const rows: Record<string, SessionEntry> = {
      [ROOT_KEY]: legacyRoot({ sessionId: "eligible" }),
      ...Object.fromEntries(
        exclusions.map((fields, index) => [
          dashboardRootKey(index + 2),
          legacyRoot({ sessionId: `excluded-${index}`, ...fields }),
        ]),
      ),
      "agent:main:discord:group:123": legacyRoot({ sessionId: "channel-key" }),
      "agent:main:main": legacyRoot({ sessionId: "main-key" }),
      "agent:main:dashboard:incognito-7d3c1f00": legacyRoot({ sessionId: "incognito-key" }),
      [dashboardRootKey(13, "ops")]: legacyRoot({ sessionId: "other-agent-parent" }),
    };
    const settle = async () => {
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
    };
    const read = () => readEntries(fixture);
    const write = (entries: Record<string, SessionEntry>) => {
      for (const [sessionKey, entry] of Object.entries(entries)) {
        fixture.insert(sessionKey, entry);
      }
    };
    const runRepairCycle = async (
      cfg: OpenClawConfig,
      before: Record<string, SessionEntry>,
      eligibleKey: string,
    ) => {
      const preview = repairLegacyDashboardChatTypes({ apply: false, cfg, env });
      await settle();
      expect(preview).toMatchObject({ found: 1, repaired: 0 });
      expect(read()).toEqual(before);
      expectNote("Would record");

      const fixed = repairLegacyDashboardChatTypes({ apply: true, cfg, env });
      await settle();
      expect(fixed).toMatchObject({ found: 1, repaired: 1 });
      const eligible = before[eligibleKey];
      if (!eligible) {
        throw new Error(`Missing eligible dashboard fixture: ${eligibleKey}`);
      }
      const after = {
        ...before,
        [eligibleKey]: { ...eligible, chatType: "direct" as const },
      };
      // The stamp is the only change: every other durable field stays current.
      expect(read()).toEqual(after);
      expectNote("Recorded");
      const repeated = repairLegacyDashboardChatTypes({ apply: true, cfg, env });
      await settle();
      expect(repeated).toMatchObject({ found: 0, repaired: 0 });
      expect(read()).toEqual(after);
      expect(note).not.toHaveBeenCalledWith(expect.anything(), "Session chat type");
    };

    write(rows);
    await runRepairCycle(config, read(), ROOT_KEY);

    const customConfig: OpenClawConfig = {
      ...config,
      session: { ...config.session, mainKey: "home" },
    };
    const customMainKey = dashboardRootKey(15);
    const customRows = {
      [dashboardRootKey(14)]: legacyRoot({ sessionId: "default-parent-under-custom-main" }),
      [customMainKey]: legacyRoot({
        sessionId: "custom-main-parent",
        parentSessionKey: "agent:main:home",
      }),
    };
    write(customRows);
    await runRepairCycle(customConfig, read(), customMainKey);

    await state.cleanup();
    state = await createOpenClawTestState({
      prefix: "openclaw-doctor-dashboard-chat-type-wiring-",
    });
    const doctorFixture = createCanonicalRepairFixture(state.stateDir);
    const doctorConfig: OpenClawConfig = {
      ...doctorFixture.cfg,
      plugins: { enabled: false },
    };
    const doctorKey = dashboardRootKey(16);
    const doctorEntry = legacyRoot({ sessionId: "doctor-wiring" });
    doctorFixture.insert(doctorKey, doctorEntry);
    const readDoctorEntry = () => readEntries(doctorFixture)[doctorKey];
    const runDoctor = async (shouldRepair: boolean) => {
      await noteSessionTranscriptHealth({
        cfg: doctorConfig,
        env: doctorFixture.env,
        shouldRepair,
      });
      await settle();
    };
    setRuntimeConfigSnapshot(doctorConfig);

    await runDoctor(false);
    expect(readDoctorEntry()).toEqual(doctorEntry);
    expectNote("Would record");

    await runDoctor(true);
    expect(readDoctorEntry()).toMatchObject({
      ...doctorEntry,
      chatType: "direct",
    });
    expectNote("Recorded");

    await runDoctor(true);
    expect(note).not.toHaveBeenCalledWith(expect.anything(), "Session chat type");
  });
});
