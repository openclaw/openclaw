import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionStoreIdentity } from "../gateway/session-store-key.js";
import {
  parseControlUiSessionPath,
  resolveStoredSessionControlUiPath,
} from "./session-discussion.js";

const config: OpenClawConfig = {
  agents: { entries: { research: {} } },
  session: { mainKey: "workspace", scope: "per-sender" },
};

describe("stored-session source links", () => {
  it.each(["planning", "dashboard:01234567-89ab-cdef-0123-456789abcdef"])(
    "uses ordinary Gateway routing for a qualified %s row",
    async (rest) => {
      const sessionKey = `agent:research:${rest}`;
      for (const mainKey of ["workspace", "changed-home"]) {
        const cfg = { ...config, session: { ...config.session, mainKey } };
        const path = await resolveStoredSessionControlUiPath({
          config: cfg,
          agentId: "research",
          sessionKey,
        });
        expect(path).toBeDefined();
        const route = parseControlUiSessionPath(path!, "", mainKey);
        expect(route).toMatchObject({ kind: "literal", agentId: "research", sessionKey });
        expect(resolveSessionStoreIdentity({ cfg, agentId: "research", sessionKey })).toEqual({
          agentId: "research",
          canonicalKey: sessionKey,
        });
      }
    },
  );

  it.each([
    "main",
    "global",
    "unknown",
    "agent:research:main",
    "agent:research:workspace",
    "agent:research:global",
    "agent:retired:planning",
  ])("does not guess source navigation for %s", async (sessionKey) => {
    expect(
      await resolveStoredSessionControlUiPath({ config, agentId: "research", sessionKey }),
    ).toBeUndefined();
  });

  it("withdraws a previously eligible UUID when current routing maps it to global", async () => {
    const rest = "dashboard:01234567-89ab-cdef-0123-456789abcdef";
    const sessionKey = `agent:research:${rest}`;
    expect(
      await resolveStoredSessionControlUiPath({ config, agentId: "research", sessionKey }),
    ).toBeDefined();
    const changed: OpenClawConfig = { ...config, session: { mainKey: rest, scope: "global" } };
    expect(
      resolveSessionStoreIdentity({ cfg: changed, agentId: "research", sessionKey }).canonicalKey,
    ).toBe("global");
    expect(
      await resolveStoredSessionControlUiPath({ config: changed, agentId: "research", sessionKey }),
    ).toBeUndefined();
  });
});
