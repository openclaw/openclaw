import { describe, expect, test } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectSessionParticipant } from "./session-identity-projection.js";
import { listSessionFixture } from "./session-list.test-support.js";

describe("session identity projection agent avatars", () => {
  test("versions data avatars and keeps remote sources on the Gateway route", () => {
    const dataUrl = `data:image/png;base64,${Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
    ]).toString("base64")}`;
    const remoteUrl = "https://example.com/avatar.png";
    const base = {
      gateway: { controlUi: { basePath: "/control" } },
    } as OpenClawConfig;

    const dataCfg = {
      ...base,
      agents: { entries: { main: { identity: { name: "Main", avatar: dataUrl } } } },
    } as OpenClawConfig;
    expect(projectSessionParticipant({ type: "agent", id: "main" }, new Map(), dataCfg)).toEqual({
      identity: { type: "agent", id: "main" },
      label: "Main",
      avatarUrl: expect.stringMatching(/^\/control\/avatar\/main\?v=[a-f0-9]+$/),
    });

    // External URLs are not renderable in Control UI; stay on the Gateway-owned route.
    const remoteCfg = {
      ...base,
      agents: { entries: { main: { identity: { name: "Main", avatar: remoteUrl } } } },
    } as OpenClawConfig;
    expect(projectSessionParticipant({ type: "agent", id: "main" }, new Map(), remoteCfg)).toEqual({
      identity: { type: "agent", id: "main" },
      label: "Main",
      avatarUrl: "/control/avatar/main",
    });

    const unsupportedCfg = {
      ...base,
      agents: {
        entries: { main: { identity: { name: "Main", avatar: "data:text/html,<html>" } } },
      },
    } as OpenClawConfig;
    expect(
      projectSessionParticipant({ type: "agent", id: "main" }, new Map(), unsupportedCfg),
    ).toEqual({
      identity: { type: "agent", id: "main" },
      label: "Main",
    });
  });

  test("sessions.list owner actor carries the same revisioned agent avatar URL", async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
    ]).toString("base64")}`;
    const cfg = {
      agents: { entries: { main: { identity: { name: "Main", avatar: dataUrl } } } },
      gateway: { controlUi: { basePath: "/control" } },
    } as OpenClawConfig;
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "sess-avatar-revision",
        updatedAt: 1,
        createdActor: { type: "agent", id: "main" },
        createdVia: "operator",
      },
    };

    const result = await listSessionFixture({
      cfg,
      storePath: "",
      store,
      opts: {},
    });
    expect(result.sessions).toHaveLength(1);
    const [row] = result.sessions;
    expect(row?.key).toBe("main");
    expect(row?.owner?.actor?.avatarUrl).toMatch(/^\/(?:control\/)?avatar\/main\?v=[a-f0-9]+$/);
  });
});
