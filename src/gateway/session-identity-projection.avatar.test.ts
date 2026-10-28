import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectSessionParticipant } from "./session-identity-projection.js";

describe("session identity projection agent avatars", () => {
  test("projects data and remote agent avatars with the agent-list URL contract", () => {
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

    const remoteCfg = {
      ...base,
      agents: { entries: { main: { identity: { name: "Main", avatar: remoteUrl } } } },
    } as OpenClawConfig;
    expect(projectSessionParticipant({ type: "agent", id: "main" }, new Map(), remoteCfg)).toEqual({
      identity: { type: "agent", id: "main" },
      label: "Main",
      avatarUrl: remoteUrl,
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
});
