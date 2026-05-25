import { describe, expect, it } from "vitest";
import {
  buildFeishuIngressPayload,
  evaluateFeishuLiveE2eGate,
  resolveFeishuLiveE2eEnv,
} from "../../scripts/lib/claworks-feishu-live-e2e-gate.mjs";

describe("claworks feishu live e2e gate", () => {
  it("skips when credentials missing", () => {
    const gate = evaluateFeishuLiveE2eGate({});
    expect(gate.skip).toBe(true);
    if (gate.skip) {
      expect(gate.reason).toContain("FEISHU_APP_ID");
    }
  });

  it("skips when chat target missing", () => {
    const gate = evaluateFeishuLiveE2eGate({
      FEISHU_APP_ID: "cli_xxx",
      FEISHU_APP_SECRET: "secret",
    });
    expect(gate.skip).toBe(true);
    if (gate.skip) {
      expect(gate.reason).toContain("FEISHU_TEST_CHAT_ID");
    }
  });

  it("passes gate with minimal env", () => {
    const gate = evaluateFeishuLiveE2eGate({
      FEISHU_APP_ID: "cli_xxx",
      FEISHU_APP_SECRET: "secret",
      FEISHU_TEST_CHAT_ID: "oc_test",
      CLAWORKS_GATEWAY_URL: "http://gateway:18800/",
    });
    expect(gate.skip).toBe(false);
    if (!gate.skip) {
      expect(gate.env.gatewayUrl).toBe("http://gateway:18800");
      expect(gate.env.chatId).toBe("oc_test");
    }
  });

  it("builds REST ingress payload for /v1/events", () => {
    const env = resolveFeishuLiveE2eEnv({
      FEISHU_TEST_OPEN_ID: "ou_abc",
    });
    const payload = buildFeishuIngressPayload({
      chatId: env.chatId,
      openId: env.openId,
      probeText: "probe-1",
    });
    expect(payload.body.payload.text).toBe("probe-1");
    expect(payload.headers["X-ClaWorks-Channel-User"]).toBe("feishu:ou_abc");
    expect(payload.body.payload.channel).toBe("feishu");
  });
});
