import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  buildCommandTextFromArgs as commandText,
  findCommandByNativeName,
  formatCommandArgMenuTitle as menuTitle,
  parseCommandArgs,
  resolveCommandArgMenuAsync as resolveMenu,
} from "./commands-registry.js";
import type { VerboseLevel } from "./thinking.js";
type Level = VerboseLevel | undefined;

describe("native verbose menu status", () => {
  const session = { agentId: "target", sessionKey: "global" };
  const unrelated = { ...session, sessionKey: "agent:target:unrelated" };
  const command = expectDefined(findCommandByNativeName("verbose"), "verbose command");

  const store = (
    target: typeof session,
    verboseLevel: VerboseLevel,
    updatedAt = 1,
    sessionId = `${target.agentId}-session`,
  ) => replaceSessionEntry(target, { sessionId, updatedAt, verboseLevel });
  const menuFor = async (cfg: OpenClawConfig) =>
    expectDefined(await resolveMenu({ command, cfg, session }), "verbose menu");
  const title = (level: VerboseLevel) =>
    `Current verbose level: ${level}.\nChoose on, off, or full for /verbose.`;

  it.each<[string, Level, Level, Level, VerboseLevel]>([
    ["built-in default", undefined, undefined, undefined, "off"],
    ["global default", "on", undefined, undefined, "on"],
    ["agent default", "on", "full", undefined, "full"],
    ["stored off", undefined, "full", "off", "off"],
  ])(
    "shows %s without borrowing or mutating state",
    (_name, defaultLevel, agentLevel, storedLevel, expected) =>
      withOpenClawTestState({ label: "verbose-menu" }, async (state) => {
        const cfg: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: { target: { verboseDefault: agentLevel }, other: {} },
            defaults: { verboseDefault: defaultLevel },
          },
        };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        await store({ agentId: "other", sessionKey: session.sessionKey }, "on");
        await store(unrelated, "on", 1, "unrelated-session");
        if (storedLevel) {
          await store(session, storedLevel);
        }
        const before = loadSessionEntryReadOnly(session);
        const menu = await menuFor(cfg);
        expect(menuTitle({ command, menu })).toBe(title(expected));
        expect(
          menu.choices.map(({ value }) =>
            commandText(command, { values: { [menu.arg.name]: value } }),
          ),
        ).toEqual(["/verbose on", "/verbose off", "/verbose full"]);
        expect(loadSessionEntryReadOnly(session)).toEqual(before);
        const changedLevel = expected === "full" ? "off" : "full";
        await store(session, changedLevel, 2);
        expect(menuTitle({ command, menu: await menuFor(cfg) })).toBe(title(changedLevel));
      }),
  );

  it("leaves explicit arguments to directive dispatch, including invalid levels", async () => {
    expect(await resolveMenu({ command, args: parseCommandArgs(command, "invalid") })).toBeNull();
  });
});
