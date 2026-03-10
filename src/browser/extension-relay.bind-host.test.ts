import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  ensureChromeExtensionRelayServer,
  stopChromeExtensionRelayServer,
} from "./extension-relay.js";
import { getFreePort } from "./test-port.js";

describe("chrome extension relay bindHost coordination", () => {
  let cdpUrl = "";
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_GATEWAY_TOKEN"]);
    process.env.OPENCLAW_GATEWAY_TOKEN = "test-gateway-token";
  });

  afterEach(async () => {
    if (cdpUrl) {
      await stopChromeExtensionRelayServer({ cdpUrl }).catch(() => {});
      cdpUrl = "";
    }
    envSnapshot.restore();
  });

  it("rebinds the relay when concurrent callers request different bind hosts", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;

    const [first, second] = await Promise.all([
      ensureChromeExtensionRelayServer({ cdpUrl }),
      ensureChromeExtensionRelayServer({ cdpUrl, bindHost: "0.0.0.0" }),
    ]);

    const settled = await ensureChromeExtensionRelayServer({
      cdpUrl,
      bindHost: "0.0.0.0",
    });

    expect(first.port).toBe(port);
    expect(second.port).toBe(port);
    expect(second).not.toBe(first);
    expect(second.bindHost).toBe("0.0.0.0");
    expect(settled).toBe(second);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
  });
});
