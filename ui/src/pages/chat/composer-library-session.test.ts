// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  SkillsLibraryActivateResult,
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { SLASH_COMMANDS } from "../../lib/chat/commands.ts";
import { refreshSlashCommands } from "../../lib/chat/slash-command-catalog.ts";
import { buildSkillLibraryMock } from "../../test-helpers/skill-library-fixtures.ts";
import { ComposerLibrarySession } from "./composer-library-session.ts";

const read = buildSkillLibraryMock()[0];
const sessionKey = "agent:main:alice";
const list: SkillsLibraryListResult = {
  entries: [],
  profileId: "profile-bob",
  multipleProfiles: true,
  defaultTarget: "personal",
  canManageWorkspace: false,
  defaultSelectionLimit: 64,
  session: { sessionKey, selections: [], attachable: [] },
};
const activated: SkillsLibraryActivateResult = {
  sessionKey,
  selections: [],
  sessionActivation: "next-turn",
};

describe("composer session library ownership", () => {
  it.each(["list", "read", "activate"] as const)(
    "discards a late %s result after the viewer connection changes",
    async (operation) => {
      const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:12345" });
      const { promise: deferred, resolve } = createDeferred<
        SkillsLibraryListResult | SkillsLibraryReadResult | SkillsLibraryActivateResult
      >();
      const request = vi.spyOn(client, "request").mockImplementationOnce(async () => deferred);
      const library = new ComposerLibrarySession(vi.fn());
      let epoch = 1;
      library.synchronize({
        client,
        connectionEpoch: 1,
        sessionKey,
        agentId: "main",
        isCurrent: () => epoch === 1,
      });
      const pending =
        operation === "list"
          ? library.load()
          : operation === "read"
            ? library.openRead(read.entry.skillId, read.entry.revision)
            : library.activate("detach", read.entry.skillId);
      epoch = 2;
      library.synchronize({
        client,
        connectionEpoch: 2,
        sessionKey,
        agentId: "main",
        isCurrent: () => epoch === 2,
      });
      resolve(operation === "list" ? list : operation === "read" ? read : activated);
      const feedback = await pending;
      if (operation === "activate") {
        expect(feedback).toBeNull();
      }
      expect(library.result).toBeNull();
      expect(library.read).toBeNull();
      expect(library.busy).toBe(false);
      expect(library.loading).toBe(false);
      expect(request).toHaveBeenCalledTimes(1);
      request.mockResolvedValue(list);
      await library.load();
      expect(library.result).toEqual(list);
      expect(request).toHaveBeenLastCalledWith("skills.library.list", { sessionKey });
      request.mockRestore();
    },
  );

  it.each(["success", "write-error", "refresh-error"] as const)(
    "returns current activation feedback only after successful refresh (%s)",
    async (outcome) => {
      const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:12345" });
      const request = vi.spyOn(client, "request").mockResolvedValue({ commands: [] });
      onTestFinished(() => request.mockRestore());
      if (outcome === "write-error") {
        request.mockRejectedValueOnce(new Error("Selection could not be saved."));
      } else {
        request.mockResolvedValueOnce(activated);
        if (outcome === "refresh-error") {
          request.mockRejectedValueOnce(new Error("Library could not be refreshed."));
        } else {
          request.mockResolvedValueOnce(list);
        }
      }
      const library = new ComposerLibrarySession(vi.fn());
      library.synchronize({
        client,
        connectionEpoch: 1,
        sessionKey,
        agentId: "main",
        isCurrent: () => true,
      });
      const feedback = await library.activate("refresh", read.entry.skillId);
      expect(feedback).toBe(
        outcome === "success"
          ? "Skill selections updated for the next turn. An active turn keeps its current revision."
          : null,
      );
      expect(library.busy).toBe(false);
      expect(library.error).toBe(
        outcome === "success"
          ? null
          : outcome === "write-error"
            ? "Selection could not be saved."
            : "Library could not be refreshed.",
      );
    },
  );

  it("retires every cached command variant of the session when metadata refresh fails", async () => {
    const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:12345" });
    const pin = (name: string) => ({
      commands: [
        { name, textAliases: [`/${name}`], description: name, source: "plugin", scope: "text" },
      ],
    });
    const { promise: lateBeta, resolve: settleBeta } = createDeferred<unknown>();
    const catalogs = [pin("old_alpha"), pin("old_wt"), pin("other_pin"), lateBeta];
    catalogs.push(pin("new_alpha"), pin("new_wt"), pin("new_beta"));
    const request = vi.spyOn(client, "request").mockImplementation(async (method) => {
      if (method === "commands.list") {
        return catalogs.shift();
      }
      if (method === "skills.library.activate") {
        return activated;
      }
      if (method === "skills.library.list") {
        return list;
      }
      throw new Error("Chat metadata could not be refreshed.");
    });
    onTestFinished(async () => {
      request.mockRestore();
      await refreshSlashCommands({ client: null });
    });
    const open = (sessionSkillScope: string, key = sessionKey) =>
      refreshSlashCommands({ client, agentId: "main", sessionKey: key, sessionSkillScope });
    const shown = (name: string) => SLASH_COMMANDS.some((command) => command.name === name);
    await open('[null,"/alpha"]');
    await open('["wt",null]');
    await open('[null,"/other"]', "agent:main:other");
    const stale = open('[null,"/beta"]');
    const library = new ComposerLibrarySession(vi.fn());
    library.synchronize({
      client,
      connectionEpoch: 1,
      sessionKey,
      agentId: "main",
      isCurrent: () => true,
    });
    expect(await library.activate("refresh", read.entry.skillId)).toBeNull();
    expect(library.error).toBe("Chat metadata could not be refreshed.");
    // A catalog read started before activation can neither apply nor repopulate the cache.
    settleBeta(pin("stale_beta"));
    await stale;
    expect(shown("stale_beta")).toBe(false);
    for (const [scope, name] of [
      ['[null,"/alpha"]', "new_alpha"],
      ['["wt",null]', "new_wt"],
      ['[null,"/beta"]', "new_beta"],
    ] as const) {
      await open(scope);
      expect.soft(shown(name), name).toBe(true);
    }
    // Other sessions keep their cached catalog.
    await open('[null,"/other"]', "agent:main:other");
    expect(shown("other_pin")).toBe(true);
    expect(request.mock.calls.filter(([method]) => method === "commands.list")).toHaveLength(7);
  });
});
