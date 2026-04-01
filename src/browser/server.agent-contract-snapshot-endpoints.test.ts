import { fetch as realFetch } from "undici";
import { describe, expect, it } from "vitest";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "./constants.js";
import {
  installAgentContractHooks,
  postJson,
  startServerAndBase,
} from "./server.agent-contract.test-harness.js";
import {
  getBrowserControlServerTestState,
  getCdpMocks,
  getPwMocks,
} from "./server.control-server.test-harness.js";

const state = getBrowserControlServerTestState();
const cdpMocks = getCdpMocks();
const pwMocks = getPwMocks();

describe("browser control server", () => {
  installAgentContractHooks();

  it("agent contract: snapshot endpoints", async () => {
    const base = await startServerAndBase();

    const snapAria = (await realFetch(`${base}/snapshot?format=aria&limit=1`).then((r) =>
      r.json(),
    )) as { ok: boolean; format?: string };
    expect(snapAria.ok).toBe(true);
    expect(snapAria.format).toBe("aria");
    expect(cdpMocks.snapshotAria).toHaveBeenCalledWith({
      wsUrl: "ws://127.0.0.1/devtools/page/abcd1234",
      limit: 1,
    });

    const snapAi = (await realFetch(`${base}/snapshot?format=ai`).then((r) => r.json())) as {
      ok: boolean;
      format?: string;
    };
    expect(snapAi.ok).toBe(true);
    expect(snapAi.format).toBe("ai");
    expect(pwMocks.snapshotAiViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      maxChars: DEFAULT_AI_SNAPSHOT_MAX_CHARS,
    });

    const snapAiZero = (await realFetch(`${base}/snapshot?format=ai&maxChars=0`).then((r) =>
      r.json(),
    )) as { ok: boolean; format?: string };
    expect(snapAiZero.ok).toBe(true);
    expect(snapAiZero.format).toBe("ai");
    const [lastCall] = pwMocks.snapshotAiViaPlaywright.mock.calls.at(-1) ?? [];
    expect(lastCall).toEqual({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
    });
  });

  it("agent contract: navigation + common act commands", async () => {
    const base = await startServerAndBase();

    const nav = await postJson<{ ok: boolean; targetId?: string }>(`${base}/navigate`, {
      url: "https://example.com",
    });
    expect(nav.ok).toBe(true);
    expect(typeof nav.targetId).toBe("string");
    expect(pwMocks.navigateViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: state.cdpBaseUrl,
        targetId: "abcd1234",
        url: "https://example.com",
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
        },
      }),
    );

    const click = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "click",
      ref: "1",
      button: "left",
      modifiers: ["Shift"],
    });
    expect(click.ok).toBe(true);
    expect(pwMocks.clickViaPlaywright).toHaveBeenNthCalledWith(1, {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      ref: "1",
      doubleClick: false,
      button: "left",
      modifiers: ["Shift"],
    });

    const clickSelector = await realFetch(`${base}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "click", selector: "button.save" }),
    });
    expect(clickSelector.status).toBe(400);
    expect(((await clickSelector.json()) as { error?: string }).error).toMatch(
      /'selector' is not supported/i,
    );

    const type = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "type",
      ref: "1",
      text: "",
    });
    expect(type.ok).toBe(true);
    expect(pwMocks.typeViaPlaywright).toHaveBeenNthCalledWith(1, {
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      ref: "1",
      text: "",
      submit: false,
      slowly: false,
    });

    const press = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "press",
      key: "Enter",
    });
    expect(press.ok).toBe(true);
    expect(pwMocks.pressKeyViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      key: "Enter",
    });

    const hover = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "hover",
      ref: "2",
    });
    expect(hover.ok).toBe(true);
    expect(pwMocks.hoverViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      ref: "2",
    });

    const scroll = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "scrollIntoView",
      ref: "2",
    });
    expect(scroll.ok).toBe(true);
    expect(pwMocks.scrollIntoViewViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      ref: "2",
    });

    const drag = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "drag",
      startRef: "3",
      endRef: "4",
    });
    expect(drag.ok).toBe(true);
    expect(pwMocks.dragViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      targetId: "abcd1234",
      startRef: "3",
      endRef: "4",
    });
  });
});
