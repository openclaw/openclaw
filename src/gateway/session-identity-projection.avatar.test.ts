import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as imageOps from "../media/image-ops.js";
import { handleControlUiAvatarRequest } from "./control-ui.js";
import { projectSessionParticipant } from "./session-identity-projection.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const dataAvatarUrl = () =>
  `data:image/png;base64,${createSolidPngBuffer(2, 2, { r: 34, g: 197, b: 94 }).toString("base64")}`;

async function requestAvatar(url: string, cfg: OpenClawConfig, basePath = "/control") {
  const response = makeMockHttpResponse();
  await handleControlUiAvatarRequest(
    {
      url,
      method: "GET",
      headers: { authorization: "Bearer test-token" },
      socket: { remoteAddress: "127.0.0.1" },
    } as IncomingMessage,
    response.res,
    {
      config: cfg,
      basePath,
      auth: { mode: "token" as const, token: "test-token", allowTailscale: false },
    },
  );
  return response;
}

describe("session identity projection agent avatars", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearRuntimeConfigSnapshot();
  });

  test("versions data avatars and keeps remote sources on the Gateway route", () => {
    const remoteUrl = "https://example.com/avatar.png";
    const base = {
      gateway: { controlUi: { basePath: "/control" } },
    } as OpenClawConfig;

    const dataCfg = {
      ...base,
      agents: { entries: { main: { identity: { name: "Main", avatar: dataAvatarUrl() } } } },
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
    const dataUrl = dataAvatarUrl();
    const cfg = {
      agents: {
        entries: {
          main: {
            workspace: "/tmp",
            identity: { name: "Main", avatar: dataUrl },
          },
        },
      },
      gateway: { controlUi: { basePath: "/control" } },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(cfg);
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
    const ownerAvatar = row?.owner?.actor?.avatarUrl;
    expect(ownerAvatar).toMatch(/^\/(?:control\/)?avatar\/main\?v=[a-f0-9]+$/);

    // Session projection URL must be the same delivery contract the agent list uses.
    const processor = imageOps.createImageProcessor();
    vi.spyOn(imageOps, "createImageProcessor").mockReturnValue(processor);
    const response = await requestAvatar(ownerAvatar!, cfg);
    expect(response.res.statusCode).toBe(200);
    expect(response.setHeader).toHaveBeenCalledWith("content-type", "image/png");
    expect(Buffer.isBuffer(response.end.mock.calls[0]?.[0])).toBe(true);
  });
});
