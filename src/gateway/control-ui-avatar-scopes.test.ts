import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createTrustedProxyHeaders,
  setupTrustedProxyAuth,
} from "./control-ui.http.test-support.js";
import { handleControlUiAvatarRequest } from "./control-ui.js";
import { APNG_BYTES } from "./http-image.test-support.js";
import { makeMockHttpResponse } from "./test-http-response.js";

afterEach(() => clearRuntimeConfigSnapshot());

async function requestAvatar(scopes: string) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-scopes-"));
  await fs.writeFile(path.join(workspace, "avatar.png"), APNG_BYTES);
  const config: OpenClawConfig = {
    agents: { entries: { main: { workspace, identity: { avatar: "avatar.png" } } } },
  };
  setRuntimeConfigSnapshot(config);
  const headers = createTrustedProxyHeaders({ "x-openclaw-scopes": scopes });
  const req = {
    url: "/avatar/main",
    method: "GET",
    headers,
    headersDistinct: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [String(v)]])),
    socket: { remoteAddress: "10.0.0.1" },
  } as unknown as IncomingMessage;
  const response = makeMockHttpResponse();
  try {
    await handleControlUiAvatarRequest(req, response.res, {
      config,
      auth: setupTrustedProxyAuth(),
      trustedProxies: ["10.0.0.1"],
    });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
  return response.res.statusCode;
}

// Guests hold only session scopes; agent.identity.get already hands them this avatar URL.
it("serves agent avatar bytes to session-scoped readers", async () => {
  expect(await requestAvatar("operator.sessions.write")).toBe(200);
  expect(await requestAvatar("operator.approvals")).toBe(403);
});
