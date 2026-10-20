import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  parseCommandArgs,
  resolveCommandArgMenuAsync,
} from "./commands-registry.js";
import type { VerboseLevel } from "./thinking.js";

describe("native verbose menu status", () => {
  let state: OpenClawTestState;
  const session = { agentId: "target", sessionKey: "global" };
  const command = expectDefined(findCommandByNativeName("verbose"), "verbose command");

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "verbose-menu" });
  });
  afterEach(() => state.cleanup());

  const store = (
    target: typeof session,
    verboseLevel: VerboseLevel,
    updatedAt = 1,
    sessionId = `${target.agentId}-session`,
  ) => replaceSessionEntry(target, { sessionId, updatedAt, verboseLevel });
  const menuFor = async (cfg: OpenClawConfig) =>
    expectDefined(await resolveCommandArgMenuAsync({ command, cfg, session }), "verbose menu");
  const title = (level: VerboseLevel) =>
    `Current verbose level: ${level}.\nChoose on, off, or full for /verbose.`;

  it.each<{
    name: string;
    defaultLevel?: VerboseLevel;
    agentLevel?: VerboseLevel;
    storedLevel?: VerboseLevel;
    expected: VerboseLevel;
  }>([
    { name: "built-in default", expected: "off" },
    { name: "global default", defaultLevel: "on", expected: "on" },
    { name: "agent default", defaultLevel: "on", agentLevel: "full", expected: "full" },
    { name: "stored off", agentLevel: "full", storedLevel: "off", expected: "off" },
  ])("shows $name without changing or borrowing session state", async (testCase) => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { target: { verboseDefault: testCase.agentLevel }, other: {} },
        defaults: { verboseDefault: testCase.defaultLevel },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    await store({ agentId: "other", sessionKey: session.sessionKey }, "on");
    await store({ ...session, sessionKey: "agent:target:unrelated" }, "on", 1, "unrelated-session");
    if (testCase.storedLevel) {
      await store(session, testCase.storedLevel);
    }
    const before = loadSessionEntryReadOnly(session);
    const menu = await menuFor(cfg);
    expect(formatCommandArgMenuTitle({ command, menu })).toBe(title(testCase.expected));
    expect(
      menu.choices.map((choice) =>
        buildCommandTextFromArgs(command, { values: { [menu.arg.name]: choice.value } }),
      ),
    ).toEqual(["/verbose on", "/verbose off", "/verbose full"]);
    expect(loadSessionEntryReadOnly(session)).toEqual(before);
    const changedLevel = testCase.expected === "full" ? "off" : "full";
    await store(session, changedLevel, 2);
    expect(formatCommandArgMenuTitle({ command, menu: await menuFor(cfg) })).toBe(
      title(changedLevel),
    );
  });

  it("leaves explicit arguments to directive dispatch, including invalid levels", async () => {
    expect(
      await resolveCommandArgMenuAsync({ command, args: parseCommandArgs(command, "invalid") }),
    ).toBeNull();
  });
});
