import { fetch as realFetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserControlServerBaseUrl,
  getBrowserControlServerTestState,
  getCdpMocks,
  getFreePort,
  installBrowserControlServerHooks,
  makeResponse,
  getPwMocks,
  startBrowserControlServerFromConfig,
  stopBrowserControlServer,
} from "./server.control-server.test-harness.js";

const state = getBrowserControlServerTestState();
const cdpMocks = getCdpMocks();
const pwMocks = getPwMocks();

describe("browser control server", () => {
  installBrowserControlServerHooks();

  it("POST /tabs/open?profile=unknown returns 404", async () => {
    await startBrowserControlServerFromConfig();
    const base = getBrowserControlServerBaseUrl();

    const result = await realFetch(`${base}/tabs/open?profile=unknown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(result.status).toBe(404);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("not found");
  });

  it("POST /tabs/open returns 400 for invalid URLs", async () => {
    await startBrowserControlServerFromConfig();
    const base = getBrowserControlServerBaseUrl();

    const result = await realFetch(`${base}/tabs/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not a url" }),
    });
    expect(result.status).toBe(400);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("Invalid URL:");
  });
});

describe("profile CRUD endpoints", () => {
  beforeEach(async () => {
    state.reachable = false;
    state.cfgAttachOnly = false;

    for (const fn of Object.values(pwMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(cdpMocks)) {
      fn.mockClear();
    }

    state.testPort = await getFreePort();
    state.cdpBaseUrl = `http://127.0.0.1:${state.testPort + 1}`;
    state.prevGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
    process.env.OPENCLAW_GATEWAY_PORT = String(state.testPort - 2);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/json/list")) {
          return makeResponse([]);
        }
        return makeResponse({}, { ok: false, status: 500, text: "unexpected" });
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (state.prevGatewayPort === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PORT;
    } else {
      process.env.OPENCLAW_GATEWAY_PORT = state.prevGatewayPort;
    }
    await stopBrowserControlServer();
  });

  it("validates profile create/delete endpoints", async () => {
    await startBrowserControlServerFromConfig();
    const base = getBrowserControlServerBaseUrl();

    const createMissingName = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(createMissingName.status).toBe(400);
    const createMissingNameBody = (await createMissingName.json()) as { error: string };
    expect(createMissingNameBody.error).toContain("name is required");

    const createInvalidName = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Invalid Name!" }),
    });
    expect(createInvalidName.status).toBe(400);
    const createInvalidNameBody = (await createInvalidName.json()) as { error: string };
    expect(createInvalidNameBody.error).toContain("invalid profile name");

    const createDuplicate = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openclaw" }),
    });
    expect(createDuplicate.status).toBe(409);
    const createDuplicateBody = (await createDuplicate.json()) as { error: string };
    expect(createDuplicateBody.error).toContain("already exists");

    const createRemote = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "remote", cdpUrl: "http://10.0.0.42:9222" }),
    });
    expect(createRemote.status).toBe(200);
    const createRemoteBody = (await createRemote.json()) as {
      profile?: string;
      cdpUrl?: string;
      isRemote?: boolean;
    };
    expect(createRemoteBody.profile).toBe("remote");
    expect(createRemoteBody.cdpUrl).toBe("http://10.0.0.42:9222");
    expect(createRemoteBody.isRemote).toBe(true);

    const createBadRemote = await realFetch(`${base}/profiles/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "badremote", cdpUrl: "ws://bad" }),
    });
    expect(createBadRemote.status).toBe(400);
    const createBadRemoteBody = (await createBadRemote.json()) as { error: string };
    expect(createBadRemoteBody.error).toContain("cdpUrl");

    const deleteMissing = await realFetch(`${base}/profiles/nonexistent`, {
      method: "DELETE",
    });
    expect(deleteMissing.status).toBe(404);
    const deleteMissingBody = (await deleteMissing.json()) as { error: string };
    expect(deleteMissingBody.error).toContain("not found");

    const deleteDefault = await realFetch(`${base}/profiles/openclaw`, {
      method: "DELETE",
    });
    expect(deleteDefault.status).toBe(400);
    const deleteDefaultBody = (await deleteDefault.json()) as { error: string };
    expect(deleteDefaultBody.error).toContain("cannot delete the default profile");

    const deleteInvalid = await realFetch(`${base}/profiles/Invalid-Name!`, {
      method: "DELETE",
    });
    expect(deleteInvalid.status).toBe(400);
    const deleteInvalidBody = (await deleteInvalid.json()) as { error: string };
    expect(deleteInvalidBody.error).toContain("invalid profile name");
  });
});
